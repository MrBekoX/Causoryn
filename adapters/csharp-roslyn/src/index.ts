export {
  analyzeCSharpWorkspace,
  discoverNugetReferenceDirs,
} from "./analyzer.js";
export { resolveCSharpProjects } from "./project-model.js";
export { trustedNugetPackageRoots, type NugetTrustOptions, type TrustedNugetRoot } from "./nuget-roots.js";
export {
  CSHARP_ROSLYN_ADAPTER_ID,
  CSHARP_ROSLYN_ADAPTER_VERSION,
  DEFAULT_DOTNET_COMMAND,
  DEFAULT_REQUEST_TIMEOUT_MS,
  MAX_CSHARP_PROJECTS,
  MAX_NUGET_REFERENCE_DIRS,
  MAX_PROJECT_ASSETS_BYTES,
  MAX_PROJECT_FILE_BYTES,
  WORKER_DLL_RELATIVE_PATH,
  WORKER_UNAVAILABLE_CAPABILITIES,
} from "./types.js";
export type {
  AnalyzeCSharpWorkspaceInput,
  CSharpGlobalUsing,
  CSharpProjectDiscoveryResult,
  CSharpProjectSpec,
  NugetReferenceDiscoveryResult,
  RoslynAdapterCapabilities,
  RoslynAdapterDiagnostic,
  RoslynAdapterOptions,
  RoslynAdapterResult,
  RoslynSourceFile,
  SpawnFunction,
} from "./types.js";
export {
  runWorkerAnalyze,
} from "./worker-process.js";
export type { WorkerRunOutcome } from "./worker-process.js";
