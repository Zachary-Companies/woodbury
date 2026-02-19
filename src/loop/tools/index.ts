// File system tools
export { fileReadDefinition, fileReadHandler } from './file-read.js';
export { fileWriteDefinition, fileWriteHandler } from './file-write.js';
export { listDirectoryDefinition, listDirectoryHandler } from './list-directory.js';
export { fileSearchDefinition, fileSearchHandler } from './file-search.js';
export { grepDefinition, grepHandler } from './grep.js';
export { pdfReadDefinition, pdfReadHandler } from './pdf-read.js';

// Execution tools
export { codeExecuteDefinition, codeExecuteHandler } from './code-execute.js';
export { shellExecuteDefinition, shellExecuteHandler } from './shell-execute.js';
export { gitDefinition, gitHandler } from './git.js';
export { testRunnerDefinition, testRunnerHandler } from './test-runner.js';
// Alias for backwards compatibility  
export { testRunnerDefinition as testRunDefinition, testRunnerHandler as testRunHandler } from './test-runner.js';

// Web tools
export { webFetchDefinition, webFetchHandler } from './web-fetch.js';
export { webCrawlDefinition, webCrawlHandler } from './web-crawl.js';
export { webCrawlRenderedDefinition, webCrawlRenderedHandler } from './web-crawl-rendered.js';

// Search tools
export { googleSearchDefinition, googleSearchHandler } from './google-search.js';
export { duckduckgoSearchDefinition, duckduckgoSearchHandler } from './duckduckgo-search.js';
export { searxngSearchDefinition, searxngSearchHandler } from './searxng-search.js';
export { apiSearchDefinition, apiSearchHandler } from './api-search.js';

// Database tools
export { databaseQueryDefinition, databaseQueryHandler } from './database-query.js';

// Task management tools (created earlier)
export { definition as taskCreateDefinition, handler as taskCreateHandler } from './task-create.js';
export { definition as taskUpdateDefinition, handler as taskUpdateHandler } from './task-update.js';
export { definition as taskListDefinition, handler as taskListHandler } from './task-list.js';
export { definition as taskGetDefinition, handler as taskGetHandler } from './task-get.js';

// Queue management tools (created earlier)
export { definition as queueInitDefinition, handler as queueInitHandler } from './queue-init.js';
export { definition as queueAddItemsDefinition, handler as queueAddItemsHandler } from './queue-add-items.js';
export { definition as queueNextDefinition, handler as queueNextHandler } from './queue-next.js';
export { definition as queueDoneDefinition, handler as queueDoneHandler } from './queue-done.js';
export { definition as queueStatusDefinition, handler as queueStatusHandler } from './queue-status.js';

// Meta tools (created earlier)
export { definition as delegateDefinition, handler as delegateHandler } from './delegate.js';
export { definition as goalContractDefinition, handler as goalContractHandler } from './goal-contract.js';
export { definition as reflectDefinition, handler as reflectHandler } from './reflect.js';
export { definition as memorySaveDefinition, handler as memorySaveHandler } from './memory-save.js';
export { definition as memoryRecallDefinition, handler as memoryRecallHandler } from './memory-recall.js';
export { definition as preflightCheckDefinition, handler as preflightCheckHandler } from './preflight-check.js';

// Import what we need for allTools array
import { fileReadDefinition, fileReadHandler } from './file-read.js';
import { fileWriteDefinition, fileWriteHandler } from './file-write.js';
import { listDirectoryDefinition, listDirectoryHandler } from './list-directory.js';
import { fileSearchDefinition, fileSearchHandler } from './file-search.js';
import { grepDefinition, grepHandler } from './grep.js';
import { pdfReadDefinition, pdfReadHandler } from './pdf-read.js';
import { codeExecuteDefinition, codeExecuteHandler } from './code-execute.js';
import { shellExecuteDefinition, shellExecuteHandler } from './shell-execute.js';
import { gitDefinition, gitHandler } from './git.js';
import { testRunnerDefinition, testRunnerHandler } from './test-runner.js';
import { webFetchDefinition, webFetchHandler } from './web-fetch.js';
import { webCrawlDefinition, webCrawlHandler } from './web-crawl.js';
import { webCrawlRenderedDefinition, webCrawlRenderedHandler } from './web-crawl-rendered.js';
import { googleSearchDefinition, googleSearchHandler } from './google-search.js';
import { duckduckgoSearchDefinition, duckduckgoSearchHandler } from './duckduckgo-search.js';
import { searxngSearchDefinition, searxngSearchHandler } from './searxng-search.js';
import { apiSearchDefinition, apiSearchHandler } from './api-search.js';
import { databaseQueryDefinition, databaseQueryHandler } from './database-query.js';

// All tools array for convenience
export const allTools = [
  { definition: fileReadDefinition, handler: fileReadHandler },
  { definition: fileWriteDefinition, handler: fileWriteHandler },
  { definition: listDirectoryDefinition, handler: listDirectoryHandler },
  { definition: fileSearchDefinition, handler: fileSearchHandler },
  { definition: grepDefinition, handler: grepHandler },
  { definition: pdfReadDefinition, handler: pdfReadHandler },
  { definition: codeExecuteDefinition, handler: codeExecuteHandler },
  { definition: shellExecuteDefinition, handler: shellExecuteHandler },
  { definition: gitDefinition, handler: gitHandler },
  { definition: testRunnerDefinition, handler: testRunnerHandler },
  { definition: webFetchDefinition, handler: webFetchHandler },
  { definition: webCrawlDefinition, handler: webCrawlHandler },
  { definition: webCrawlRenderedDefinition, handler: webCrawlRenderedHandler },
  { definition: googleSearchDefinition, handler: googleSearchHandler },
  { definition: duckduckgoSearchDefinition, handler: duckduckgoSearchHandler },
  { definition: searxngSearchDefinition, handler: searxngSearchHandler },
  { definition: apiSearchDefinition, handler: apiSearchHandler },
  { definition: databaseQueryDefinition, handler: databaseQueryHandler },
];
