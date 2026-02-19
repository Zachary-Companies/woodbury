/**
 * API Library Generator Module
 * Generates TypeScript API client libraries following hawksoft-api patterns
 */

export {
  ApiLibrarySpec,
  GeneratedApiLibrary,
  ApiLibraryGenerationOptions,
  SecretDefinition,
  TenantConfigUpdates,
  NpmWrapperSpec,
  generateApiLibrary,
  generateApiLibraryFromOpenApi,
  quickGenerateApiLibrary,
  generateNpmWrapperLibrary
} from './generator'

export {
  AuthConfig,
  AuthType,
  TypeDef,
  TypeFieldDef,
  EndpointDef,
  QueryParamDef,
  generatePackageJson,
  generateTsConfig,
  generateJestConfig,
  generateGitignore,
  generateClientClass,
  generateTestFile,
  generateReadme
} from './templates'
