import assert from 'assert';
import path from 'path';

import pMap from 'p-map';
import fs from 'fs-extra';
import globby from 'globby';
import { intersection, isEmpty, lensProp, map, over, pipe, reject, replace, test, uniq, without } from 'ramda';
import semver from 'semver';
import type Serverless from 'serverless';

import { ONLY_PREFIX, SERVERLESS_FOLDER } from './constants';
import {
  assertIsString,
  doSharePath,
  flatDep,
  getDepsFromBundle,
  getHandlerFilePath,
  isESM,
  stripEntryResolveExtensions,
} from './helper';
import { getPackager } from './packagers';
import { humanSize, trimExtension, zip } from './utils';

import type EsbuildServerlessPlugin from './index';
import type {
  EsbuildFunctionDefinitionHandler,
  FunctionBuildResult,
  FunctionReference,
  IFiles,
  PackageGroup,
} from './types';

function setFunctionArtifactPath(
  this: EsbuildServerlessPlugin,
  func: Serverless.FunctionDefinitionHandler,
  artifactPath: string
) {
  const version = this.serverless.getVersion();

  // Serverless changed the artifact path location in version 1.18
  if (semver.lt(version, '1.18.0')) {
    // eslint-disable-next-line no-param-reassign
    (func as any).artifact = artifactPath;
    // eslint-disable-next-line no-param-reassign, prefer-object-spread
    func.package = Object.assign({}, func.package, { disable: true });
    this.log.verbose(`${func.name} is packaged by the esbuild plugin. Ignore messages from SLS.`);
  } else {
    // eslint-disable-next-line no-param-reassign
    func.package = {
      artifact: artifactPath,
    };
  }
}

const excludedFilesDefault = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'package.json'];

export const shouldPackageSeparately = (plugin: EsbuildServerlessPlugin): boolean =>
  plugin.serverless?.service?.package?.individually === true || plugin.buildOptions?.packagePerHandler === true;

export const getArtifactNameFromBundlePath = (bundlePath: string): string => path.basename(trimExtension(bundlePath));

export const assertNoDuplicateArtifactNames = (packageGroups: PackageGroup[]): void => {
  const artifactNameToBundlePaths = new Map<string, string[]>();

  for (const { artifactName, bundlePath } of packageGroups) {
    const bundlePaths = artifactNameToBundlePaths.get(artifactName) ?? [];

    if (!bundlePaths.includes(bundlePath)) {
      bundlePaths.push(bundlePath);
    }

    artifactNameToBundlePaths.set(artifactName, bundlePaths);
  }

  const duplicates = Array.from(artifactNameToBundlePaths.entries()).filter(
    ([, bundlePaths]) => bundlePaths.length > 1
  );

  if (duplicates.length === 0) {
    return;
  }

  const details = duplicates
    .map(([artifactName, bundlePaths]) => `"${artifactName}.zip" would be used by: ${bundlePaths.join(', ')}`)
    .join('; ');

  throw new Error(`Packaging failed: duplicate handler artifact names. ${details}`);
};

export const groupBuildResultsByBundlePath = (buildResults: FunctionBuildResult[]): PackageGroup[] => {
  const groups = new Map<string, FunctionBuildResult[]>();

  for (const buildResult of buildResults) {
    const existing = groups.get(buildResult.bundlePath) ?? [];
    existing.push(buildResult);
    groups.set(buildResult.bundlePath, existing);
  }

  const packageGroups = Array.from(groups.entries()).map(([bundlePath, functions]) => {
    assert(functions[0], `No functions found for bundle path ${bundlePath}`);

    return {
      bundlePath,
      functions,
      artifactName: getArtifactNameFromBundlePath(bundlePath),
    };
  });

  assertNoDuplicateArtifactNames(packageGroups);

  return packageGroups;
};

export const filterFilesForZipPackage = ({
  files,
  functionAliases,
  includedFiles,
  excludedFiles,
  hasExternals,
  isGoogleProvider,
  depWhiteList,
}: {
  files: IFiles;
  functionAliases: string[];
  includedFiles: string[];
  excludedFiles: string[];
  hasExternals: boolean;
  isGoogleProvider: boolean;
  depWhiteList: string[];
}) => {
  return files.filter(({ localPath }) => {
    // if file is present in patterns it must be included
    if (includedFiles.find((file) => file === localPath)) {
      return true;
    }

    // exclude non individual files based on file path (and things that look derived, e.g. foo.js => foo.js.map)
    if (excludedFiles.find((file) => localPath.startsWith(`${file}.`))) {
      return false;
    }

    // exclude files that belong to individual functions
    if (
      localPath.startsWith(ONLY_PREFIX) &&
      !functionAliases.some((functionAlias) => localPath.startsWith(`${ONLY_PREFIX}${functionAlias}/`))
    ) {
      return false;
    }

    // exclude non whitelisted dependencies
    if (localPath.startsWith('node_modules')) {
      // if no externals is set or if the provider is google, we do not need any files from node_modules
      if (!hasExternals || isGoogleProvider) return false;
      if (
        // this is needed for dependencies that maps to a path (like scoped ones)
        !depWhiteList.find((dep) => doSharePath(localPath, `node_modules/${dep}`))
      )
        return false;
    }

    return true;
  });
};

const stripOnlyPrefixes = (files: IFiles, functionAliases: string[]) => {
  const strippedFiles = files.map(({ localPath, ...rest }) => {
    let strippedPath = localPath;

    for (const functionAlias of functionAliases) {
      strippedPath = strippedPath.replace(`${ONLY_PREFIX}${functionAlias}/`, '');
    }

    return { localPath: strippedPath, ...rest };
  });

  const seen = new Set<string>();

  return strippedFiles.filter(({ localPath }) => {
    if (seen.has(localPath)) {
      return false;
    }

    seen.add(localPath);

    return true;
  });
};

const getPackageGroups = (buildResults: FunctionBuildResult[], packagePerHandler: boolean): PackageGroup[] => {
  if (packagePerHandler) {
    return groupBuildResultsByBundlePath(buildResults);
  }

  return buildResults.map((buildResult) => ({
    bundlePath: buildResult.bundlePath,
    functions: [buildResult],
    artifactName: buildResult.functionAlias,
  }));
};

// eslint-disable-next-line max-statements
export async function pack(this: EsbuildServerlessPlugin) {
  // GOOGLE Provider requires a package.json and NO node_modules

  const providerName = this.serverless?.service?.provider?.name;
  const isGoogleProvider = this.serverless?.service?.provider?.name === 'google';
  const isScalewayProvider = this.serverless?.service?.provider?.name === 'scaleway'; // Scaleway can not have package: individually
  const excludedFiles = isGoogleProvider ? [] : excludedFilesDefault;
  const packagePerHandler = this.buildOptions?.packagePerHandler === true;
  const packageSeparately = shouldPackageSeparately(this);

  // Google and Scaleway providers cannot use individual packaging for now - this could be built in a future release
  const isPackageIndividuallyNotSupported = isGoogleProvider || isScalewayProvider || false;
  if (isPackageIndividuallyNotSupported && (this.serverless?.service?.package?.individually || packagePerHandler)) {
    throw new Error(`Packaging failed: cannot package function individually when using ${providerName} provider`);
  }

  const { buildDirPath, workDirPath } = this;

  assertIsString(buildDirPath, 'buildDirPath is not a string');
  assertIsString(workDirPath, 'workDirPath is not a string');

  // get a list of all path in build
  const files: IFiles = globby
    .sync('**', {
      cwd: buildDirPath,
      dot: true,
      onlyFiles: true,
    })
    .filter((file) => !excludedFiles.includes(file))
    .map((localPath) => ({ localPath, rootPath: path.join(buildDirPath, localPath) }))
    .map((file) => {
      if (this.buildOptions?.resolveExtensions && this.buildOptions.resolveExtensions.length > 0) {
        if (this.buildOptions.stripEntryResolveExtensions) {
          return stripEntryResolveExtensions(file, this.buildOptions.resolveExtensions);
        }
      }

      return file;
    });

  if (isEmpty(files)) {
    this.log.verbose('Packaging: No files found. Skipping esbuild.');
    return;
  }

  // 1) If individually is not set, just zip the all build dir and return
  if (!packageSeparately) {
    const zipName = `${this.serverless.service.service}.zip`;
    const artifactPath = path.join(workDirPath, SERVERLESS_FOLDER, zipName);

    // remove prefixes from individual extra files
    const filesPathList = pipe(
      reject(test(/^__only_[^/]+$/)) as (x: IFiles) => IFiles,
      map(over(lensProp('localPath'), replace(/^__only_[^/]+\//, '')))
    )(files);

    const startZip = Date.now();

    await zip(artifactPath, filesPathList, this.buildOptions?.nativeZip);
    const { size } = fs.statSync(artifactPath);

    this.log.verbose(
      `Zip service ${this.serverless.service.service} - ${humanSize(size)} [${Date.now() - startZip} ms]`
    );
    // defined present zip as output artifact
    this.serverless.service.package.artifact = artifactPath;

    return;
  }

  assertIsString(this.buildOptions?.packager, 'packager is not a string');

  // 2) If individually or packagePerHandler is set, we'll optimize files and zip per-function or per-handler
  const packager = await getPackager.call(this, this.buildOptions.packager, this.buildOptions.packagerOptions);

  // get a list of every function bundle
  const { buildResults } = this;

  assert(buildResults, 'buildResults is not an array');

  const packageGroups = getPackageGroups(buildResults, packagePerHandler);
  const bundlePathList = uniq(buildResults.map((results) => results.bundlePath));

  let externals: string[] = [];

  // get the list of externals to include only if exclude is not set to *
  if (this.buildOptions.exclude !== '*' && !this.buildOptions.exclude.includes('*')) {
    externals = without<string>(this.buildOptions.exclude, this.buildOptions.external ?? []);
  }

  const hasExternals = !!externals?.length;

  const { buildOptions } = this;

  // get a tree of all production dependencies
  const packagerDependenciesList = hasExternals ? await packager.getProdDependencies(buildDirPath) : {};

  const packageFiles = await globby(this.serverless.service.package.patterns);

  const zipMapper = async (packageGroup: PackageGroup) => {
    const { bundlePath, functions, artifactName } = packageGroup;
    const functionAliases = functions.map(({ functionAlias }) => functionAlias);

    const bundleExcludedFiles = bundlePathList.filter((item) => item !== bundlePath).map(trimExtension);

    const functionPackagePatterns = functions.flatMap(({ func }) => func.package?.patterns || []);

    const functionExclusionPatterns = functionPackagePatterns
      .filter((pattern) => pattern.charAt(0) === '!')
      .map((pattern) => pattern.slice(1));

    const functionFiles = await globby(functionPackagePatterns, { cwd: buildDirPath });
    const functionExcludedFiles = (await globby(functionExclusionPatterns, { cwd: buildDirPath })).map(trimExtension);

    const includedFiles = [...packageFiles, ...functionFiles];
    const excludedPackageFiles = [...bundleExcludedFiles, ...functionExcludedFiles];

    // allowed external dependencies in the final zip
    let depWhiteList: string[] = [];

    if (hasExternals && packagerDependenciesList.dependencies) {
      const bundleDeps = getDepsFromBundle(path.join(buildDirPath, bundlePath), isESM(buildOptions));
      const bundleExternals = intersection(bundleDeps, externals);

      depWhiteList = flatDep(packagerDependenciesList.dependencies, bundleExternals);
    }

    const zipName = `${artifactName}.zip`;
    const artifactPath = path.join(workDirPath, SERVERLESS_FOLDER, zipName);

    // filter files
    const filesPathList = stripOnlyPrefixes(
      filterFilesForZipPackage({
        files,
        functionAliases,
        includedFiles,
        hasExternals,
        isGoogleProvider,
        depWhiteList,
        excludedFiles: excludedPackageFiles,
      }),
      functionAliases
    );

    const startZip = Date.now();
    await zip(artifactPath, filesPathList, buildOptions.nativeZip);
    const { size } = fs.statSync(artifactPath);
    this.log.verbose(`Function zipped: ${artifactName} - ${humanSize(size)} [${Date.now() - startZip} ms]`);

    const relativeArtifactPath = path.relative(this.serviceDirPath, artifactPath);

    for (const { func } of functions) {
      setFunctionArtifactPath.call(this, func, relativeArtifactPath);
    }
  };

  this.log.verbose(`Zipping with concurrency: ${buildOptions.zipConcurrency}`);
  await pMap(packageGroups, zipMapper, { concurrency: buildOptions.zipConcurrency });
  this.log.verbose('All functions zipped.');
}

export const groupFunctionReferencesByHandlerPath = (functionReferences: FunctionReference[]): PackageGroup[] => {
  const groups = new Map<string, FunctionReference[]>();

  for (const functionReference of functionReferences) {
    const handlerPath = getHandlerFilePath(
      functionReference.func.handler,
      (functionReference.func as EsbuildFunctionDefinitionHandler).esbuildEntrypoint
    );
    const existing = groups.get(handlerPath) ?? [];
    existing.push(functionReference);
    groups.set(handlerPath, existing);
  }

  const packageGroups = Array.from(groups.entries()).map(([bundlePath, functions]) => {
    assert(functions[0], `No functions found for handler path ${bundlePath}`);

    return {
      bundlePath,
      functions: functions.map(({ func, functionAlias }) => ({
        bundlePath,
        func,
        functionAlias,
      })),
      artifactName: path.basename(bundlePath),
    };
  });

  assertNoDuplicateArtifactNames(packageGroups);

  return packageGroups;
};

export async function copyPreBuiltResources(this: EsbuildServerlessPlugin) {
  this.log.verbose('Copying Prebuilt resources');

  const { workDirPath, packageOutputPath } = this;
  const packagePerHandler = this.buildOptions?.packagePerHandler === true;
  const packageSeparately = shouldPackageSeparately(this);

  assertIsString(workDirPath, 'workDirPath is not a string');
  assertIsString(packageOutputPath, 'packageOutputPath is not a string');

  // 1) If individually is not set, just zip the all build dir and return
  if (!packageSeparately) {
    const zipName = `${this.serverless.service.service}.zip`;
    await fs.copy(path.join(packageOutputPath, zipName), path.join(workDirPath, SERVERLESS_FOLDER, zipName));
    // defined present zip as output artifact
    this.serverless.service.package.artifact = path.join(workDirPath, SERVERLESS_FOLDER, zipName);

    return;
  }

  const skippedFunctions = Object.entries(this.functions)
    .filter(([functionAlias, func]) => func && functionAlias)
    .map(([functionAlias, func]) => ({ func, functionAlias }))
    .filter(({ func }) => (func as EsbuildFunctionDefinitionHandler).skipEsbuild) as FunctionReference[];

  const packageGroups = packagePerHandler
    ? groupFunctionReferencesByHandlerPath(skippedFunctions)
    : skippedFunctions.map((functionReference) => ({
        bundlePath: functionReference.functionAlias,
        functions: [
          {
            bundlePath: functionReference.functionAlias,
            func: functionReference.func,
            functionAlias: functionReference.functionAlias,
          },
        ],
        artifactName: functionReference.functionAlias,
      }));

  assert(packageGroups, 'packageGroups is not an array');
  const zipMapper = async (packageGroup: PackageGroup) => {
    const { functions, artifactName } = packageGroup;
    const zipName = `${artifactName}.zip`;
    const artifactPath = path.join(workDirPath, SERVERLESS_FOLDER, zipName);

    await fs.copy(path.join(packageOutputPath, zipName), artifactPath);

    const relativeArtifactPath = path.relative(this.serviceDirPath, artifactPath);

    for (const { func } of functions) {
      setFunctionArtifactPath.call(this, func, relativeArtifactPath);
    }
  };

  await pMap(packageGroups, zipMapper, {});
  this.log.verbose('All functions copied.');
}
