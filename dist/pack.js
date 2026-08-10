"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.groupFunctionReferencesByHandlerPath = exports.filterFilesForZipPackage = exports.groupBuildResultsByBundlePath = exports.assertNoDuplicateArtifactNames = exports.getArtifactNameFromBundlePath = exports.shouldPackageSeparately = void 0;
exports.pack = pack;
exports.copyPreBuiltResources = copyPreBuiltResources;
const assert_1 = __importDefault(require("assert"));
const path_1 = __importDefault(require("path"));
const p_map_1 = __importDefault(require("p-map"));
const fs_extra_1 = __importDefault(require("fs-extra"));
const globby_1 = __importDefault(require("globby"));
const ramda_1 = require("ramda");
const semver_1 = __importDefault(require("semver"));
const constants_1 = require("./constants");
const helper_1 = require("./helper");
const packagers_1 = require("./packagers");
const utils_1 = require("./utils");
function setFunctionArtifactPath(func, artifactPath) {
    const version = this.serverless.getVersion();
    // Serverless changed the artifact path location in version 1.18
    if (semver_1.default.lt(version, '1.18.0')) {
        // eslint-disable-next-line no-param-reassign
        func.artifact = artifactPath;
        // eslint-disable-next-line no-param-reassign, prefer-object-spread
        func.package = Object.assign({}, func.package, { disable: true });
        this.log.verbose(`${func.name} is packaged by the esbuild plugin. Ignore messages from SLS.`);
    }
    else {
        // eslint-disable-next-line no-param-reassign
        func.package = {
            artifact: artifactPath,
        };
    }
}
const excludedFilesDefault = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'package.json'];
const shouldPackageSeparately = (plugin) => plugin.serverless?.service?.package?.individually === true || plugin.buildOptions?.packagePerHandler === true;
exports.shouldPackageSeparately = shouldPackageSeparately;
const getArtifactNameFromBundlePath = (bundlePath) => path_1.default.basename((0, utils_1.trimExtension)(bundlePath));
exports.getArtifactNameFromBundlePath = getArtifactNameFromBundlePath;
const assertNoDuplicateArtifactNames = (packageGroups) => {
    const artifactNameToBundlePaths = new Map();
    for (const { artifactName, bundlePath } of packageGroups) {
        const bundlePaths = artifactNameToBundlePaths.get(artifactName) ?? [];
        if (!bundlePaths.includes(bundlePath)) {
            bundlePaths.push(bundlePath);
        }
        artifactNameToBundlePaths.set(artifactName, bundlePaths);
    }
    const duplicates = Array.from(artifactNameToBundlePaths.entries()).filter(([, bundlePaths]) => bundlePaths.length > 1);
    if (duplicates.length === 0) {
        return;
    }
    const details = duplicates
        .map(([artifactName, bundlePaths]) => `"${artifactName}.zip" would be used by: ${bundlePaths.join(', ')}`)
        .join('; ');
    throw new Error(`Packaging failed: duplicate handler artifact names. ${details}`);
};
exports.assertNoDuplicateArtifactNames = assertNoDuplicateArtifactNames;
const groupBuildResultsByBundlePath = (buildResults) => {
    const groups = new Map();
    for (const buildResult of buildResults) {
        const existing = groups.get(buildResult.bundlePath) ?? [];
        existing.push(buildResult);
        groups.set(buildResult.bundlePath, existing);
    }
    const packageGroups = Array.from(groups.entries()).map(([bundlePath, functions]) => {
        (0, assert_1.default)(functions[0], `No functions found for bundle path ${bundlePath}`);
        return {
            bundlePath,
            functions,
            artifactName: (0, exports.getArtifactNameFromBundlePath)(bundlePath),
        };
    });
    (0, exports.assertNoDuplicateArtifactNames)(packageGroups);
    return packageGroups;
};
exports.groupBuildResultsByBundlePath = groupBuildResultsByBundlePath;
const filterFilesForZipPackage = ({ files, functionAliases, includedFiles, excludedFiles, hasExternals, isGoogleProvider, depWhiteList, }) => {
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
        if (localPath.startsWith(constants_1.ONLY_PREFIX) &&
            !functionAliases.some((functionAlias) => localPath.startsWith(`${constants_1.ONLY_PREFIX}${functionAlias}/`))) {
            return false;
        }
        // exclude non whitelisted dependencies
        if (localPath.startsWith('node_modules')) {
            // if no externals is set or if the provider is google, we do not need any files from node_modules
            if (!hasExternals || isGoogleProvider)
                return false;
            if (
            // this is needed for dependencies that maps to a path (like scoped ones)
            !depWhiteList.find((dep) => (0, helper_1.doSharePath)(localPath, `node_modules/${dep}`)))
                return false;
        }
        return true;
    });
};
exports.filterFilesForZipPackage = filterFilesForZipPackage;
const stripOnlyPrefixes = (files, functionAliases) => {
    const strippedFiles = files.map(({ localPath, ...rest }) => {
        let strippedPath = localPath;
        for (const functionAlias of functionAliases) {
            strippedPath = strippedPath.replace(`${constants_1.ONLY_PREFIX}${functionAlias}/`, '');
        }
        return { localPath: strippedPath, ...rest };
    });
    const seen = new Set();
    return strippedFiles.filter(({ localPath }) => {
        if (seen.has(localPath)) {
            return false;
        }
        seen.add(localPath);
        return true;
    });
};
const getPackageGroups = (buildResults, packagePerHandler) => {
    if (packagePerHandler) {
        return (0, exports.groupBuildResultsByBundlePath)(buildResults);
    }
    return buildResults.map((buildResult) => ({
        bundlePath: buildResult.bundlePath,
        functions: [buildResult],
        artifactName: buildResult.functionAlias,
    }));
};
// eslint-disable-next-line max-statements
async function pack() {
    // GOOGLE Provider requires a package.json and NO node_modules
    const providerName = this.serverless?.service?.provider?.name;
    const isGoogleProvider = this.serverless?.service?.provider?.name === 'google';
    const isScalewayProvider = this.serverless?.service?.provider?.name === 'scaleway'; // Scaleway can not have package: individually
    const excludedFiles = isGoogleProvider ? [] : excludedFilesDefault;
    const packagePerHandler = this.buildOptions?.packagePerHandler === true;
    const packageSeparately = (0, exports.shouldPackageSeparately)(this);
    // Google and Scaleway providers cannot use individual packaging for now - this could be built in a future release
    const isPackageIndividuallyNotSupported = isGoogleProvider || isScalewayProvider || false;
    if (isPackageIndividuallyNotSupported && (this.serverless?.service?.package?.individually || packagePerHandler)) {
        throw new Error(`Packaging failed: cannot package function individually when using ${providerName} provider`);
    }
    const { buildDirPath, workDirPath } = this;
    (0, helper_1.assertIsString)(buildDirPath, 'buildDirPath is not a string');
    (0, helper_1.assertIsString)(workDirPath, 'workDirPath is not a string');
    // get a list of all path in build
    const files = globby_1.default
        .sync('**', {
        cwd: buildDirPath,
        dot: true,
        onlyFiles: true,
    })
        .filter((file) => !excludedFiles.includes(file))
        .map((localPath) => ({ localPath, rootPath: path_1.default.join(buildDirPath, localPath) }))
        .map((file) => {
        if (this.buildOptions?.resolveExtensions && this.buildOptions.resolveExtensions.length > 0) {
            if (this.buildOptions.stripEntryResolveExtensions) {
                return (0, helper_1.stripEntryResolveExtensions)(file, this.buildOptions.resolveExtensions);
            }
        }
        return file;
    });
    if ((0, ramda_1.isEmpty)(files)) {
        this.log.verbose('Packaging: No files found. Skipping esbuild.');
        return;
    }
    // 1) If individually is not set, just zip the all build dir and return
    if (!packageSeparately) {
        const zipName = `${this.serverless.service.service}.zip`;
        const artifactPath = path_1.default.join(workDirPath, constants_1.SERVERLESS_FOLDER, zipName);
        // remove prefixes from individual extra files
        const filesPathList = (0, ramda_1.pipe)((0, ramda_1.reject)((0, ramda_1.test)(/^__only_[^/]+$/)), (0, ramda_1.map)((0, ramda_1.over)((0, ramda_1.lensProp)('localPath'), (0, ramda_1.replace)(/^__only_[^/]+\//, ''))))(files);
        const startZip = Date.now();
        await (0, utils_1.zip)(artifactPath, filesPathList, this.buildOptions?.nativeZip);
        const { size } = fs_extra_1.default.statSync(artifactPath);
        this.log.verbose(`Zip service ${this.serverless.service.service} - ${(0, utils_1.humanSize)(size)} [${Date.now() - startZip} ms]`);
        // defined present zip as output artifact
        this.serverless.service.package.artifact = artifactPath;
        return;
    }
    (0, helper_1.assertIsString)(this.buildOptions?.packager, 'packager is not a string');
    // 2) If individually or packagePerHandler is set, we'll optimize files and zip per-function or per-handler
    const packager = await packagers_1.getPackager.call(this, this.buildOptions.packager, this.buildOptions.packagerOptions);
    // get a list of every function bundle
    const { buildResults } = this;
    (0, assert_1.default)(buildResults, 'buildResults is not an array');
    const packageGroups = getPackageGroups(buildResults, packagePerHandler);
    const bundlePathList = (0, ramda_1.uniq)(buildResults.map((results) => results.bundlePath));
    let externals = [];
    // get the list of externals to include only if exclude is not set to *
    if (this.buildOptions.exclude !== '*' && !this.buildOptions.exclude.includes('*')) {
        externals = (0, ramda_1.without)(this.buildOptions.exclude, this.buildOptions.external ?? []);
    }
    const hasExternals = !!externals?.length;
    const { buildOptions } = this;
    // get a tree of all production dependencies
    const packagerDependenciesList = hasExternals ? await packager.getProdDependencies(buildDirPath) : {};
    const packageFiles = await (0, globby_1.default)(this.serverless.service.package.patterns);
    const zipMapper = async (packageGroup) => {
        const { bundlePath, functions, artifactName } = packageGroup;
        const functionAliases = functions.map(({ functionAlias }) => functionAlias);
        const bundleExcludedFiles = bundlePathList.filter((item) => item !== bundlePath).map(utils_1.trimExtension);
        const functionPackagePatterns = functions.flatMap(({ func }) => func.package?.patterns || []);
        const functionExclusionPatterns = functionPackagePatterns
            .filter((pattern) => pattern.charAt(0) === '!')
            .map((pattern) => pattern.slice(1));
        const functionFiles = await (0, globby_1.default)(functionPackagePatterns, { cwd: buildDirPath });
        const functionExcludedFiles = (await (0, globby_1.default)(functionExclusionPatterns, { cwd: buildDirPath })).map(utils_1.trimExtension);
        const includedFiles = [...packageFiles, ...functionFiles];
        const excludedPackageFiles = [...bundleExcludedFiles, ...functionExcludedFiles];
        // allowed external dependencies in the final zip
        let depWhiteList = [];
        if (hasExternals && packagerDependenciesList.dependencies) {
            const bundleDeps = (0, helper_1.getDepsFromBundle)(path_1.default.join(buildDirPath, bundlePath), (0, helper_1.isESM)(buildOptions));
            const bundleExternals = (0, ramda_1.intersection)(bundleDeps, externals);
            depWhiteList = (0, helper_1.flatDep)(packagerDependenciesList.dependencies, bundleExternals);
        }
        const zipName = `${artifactName}.zip`;
        const artifactPath = path_1.default.join(workDirPath, constants_1.SERVERLESS_FOLDER, zipName);
        // filter files
        const filesPathList = stripOnlyPrefixes((0, exports.filterFilesForZipPackage)({
            files,
            functionAliases,
            includedFiles,
            hasExternals,
            isGoogleProvider,
            depWhiteList,
            excludedFiles: excludedPackageFiles,
        }), functionAliases);
        const startZip = Date.now();
        await (0, utils_1.zip)(artifactPath, filesPathList, buildOptions.nativeZip);
        const { size } = fs_extra_1.default.statSync(artifactPath);
        this.log.verbose(`Function zipped: ${artifactName} - ${(0, utils_1.humanSize)(size)} [${Date.now() - startZip} ms]`);
        const relativeArtifactPath = path_1.default.relative(this.serviceDirPath, artifactPath);
        for (const { func } of functions) {
            setFunctionArtifactPath.call(this, func, relativeArtifactPath);
        }
    };
    this.log.verbose(`Zipping with concurrency: ${buildOptions.zipConcurrency}`);
    await (0, p_map_1.default)(packageGroups, zipMapper, { concurrency: buildOptions.zipConcurrency });
    this.log.verbose('All functions zipped.');
}
const groupFunctionReferencesByHandlerPath = (functionReferences) => {
    const groups = new Map();
    for (const functionReference of functionReferences) {
        const handlerPath = (0, helper_1.getHandlerFilePath)(functionReference.func.handler, functionReference.func.esbuildEntrypoint);
        const existing = groups.get(handlerPath) ?? [];
        existing.push(functionReference);
        groups.set(handlerPath, existing);
    }
    const packageGroups = Array.from(groups.entries()).map(([bundlePath, functions]) => {
        (0, assert_1.default)(functions[0], `No functions found for handler path ${bundlePath}`);
        return {
            bundlePath,
            functions: functions.map(({ func, functionAlias }) => ({
                bundlePath,
                func,
                functionAlias,
            })),
            artifactName: path_1.default.basename(bundlePath),
        };
    });
    (0, exports.assertNoDuplicateArtifactNames)(packageGroups);
    return packageGroups;
};
exports.groupFunctionReferencesByHandlerPath = groupFunctionReferencesByHandlerPath;
async function copyPreBuiltResources() {
    this.log.verbose('Copying Prebuilt resources');
    const { workDirPath, packageOutputPath } = this;
    const packagePerHandler = this.buildOptions?.packagePerHandler === true;
    const packageSeparately = (0, exports.shouldPackageSeparately)(this);
    (0, helper_1.assertIsString)(workDirPath, 'workDirPath is not a string');
    (0, helper_1.assertIsString)(packageOutputPath, 'packageOutputPath is not a string');
    // 1) If individually is not set, just zip the all build dir and return
    if (!packageSeparately) {
        const zipName = `${this.serverless.service.service}.zip`;
        await fs_extra_1.default.copy(path_1.default.join(packageOutputPath, zipName), path_1.default.join(workDirPath, constants_1.SERVERLESS_FOLDER, zipName));
        // defined present zip as output artifact
        this.serverless.service.package.artifact = path_1.default.join(workDirPath, constants_1.SERVERLESS_FOLDER, zipName);
        return;
    }
    const skippedFunctions = Object.entries(this.functions)
        .filter(([functionAlias, func]) => func && functionAlias)
        .map(([functionAlias, func]) => ({ func, functionAlias }))
        .filter(({ func }) => func.skipEsbuild);
    const packageGroups = packagePerHandler
        ? (0, exports.groupFunctionReferencesByHandlerPath)(skippedFunctions)
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
    (0, assert_1.default)(packageGroups, 'packageGroups is not an array');
    const zipMapper = async (packageGroup) => {
        const { functions, artifactName } = packageGroup;
        const zipName = `${artifactName}.zip`;
        const artifactPath = path_1.default.join(workDirPath, constants_1.SERVERLESS_FOLDER, zipName);
        await fs_extra_1.default.copy(path_1.default.join(packageOutputPath, zipName), artifactPath);
        const relativeArtifactPath = path_1.default.relative(this.serviceDirPath, artifactPath);
        for (const { func } of functions) {
            setFunctionArtifactPath.call(this, func, relativeArtifactPath);
        }
    };
    await (0, p_map_1.default)(packageGroups, zipMapper, {});
    this.log.verbose('All functions copied.');
}
//# sourceMappingURL=pack.js.map