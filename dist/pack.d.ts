import type EsbuildServerlessPlugin from './index';
import type { FunctionBuildResult, FunctionReference, IFiles, PackageGroup } from './types';
export declare const shouldPackageSeparately: (plugin: EsbuildServerlessPlugin) => boolean;
export declare const groupBuildResultsByBundlePath: (buildResults: FunctionBuildResult[]) => PackageGroup[];
export declare const filterFilesForZipPackage: ({
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
}) => import('./types').IFile[];
export declare function pack(this: EsbuildServerlessPlugin): Promise<void>;
export declare const groupFunctionReferencesByHandlerPath: (functionReferences: FunctionReference[]) => PackageGroup[];
export declare function copyPreBuiltResources(this: EsbuildServerlessPlugin): Promise<void>;
//# sourceMappingURL=pack.d.ts.map
