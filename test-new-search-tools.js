// Test script for the new search tools
const { duckduckgoSearch } = require('./dist/tools/duckduckgo-search');
const { searxngSearch } = require('./dist/tools/searxng-search');
const { apiSearch } = require('./dist/tools/api-search');

async function testSearchTools() {
  console.log('🔍 Testing New Search Tools\n');
  
  try {
    // Test DuckDuckGo search
    console.log('1️⃣ Testing DuckDuckGo Search...');
    const duckResult = await duckduckgoSearch.execute({
      query: 'Stripe API authentication',
      numResults: 3
    });
    
    if (duckResult.success) {
      console.log('✅ DuckDuckGo search working');
      console.log('📄 Sample result length:', duckResult.result.length);
    } else {
      console.log('❌ DuckDuckGo search failed:', duckResult.error);
    }
    
    // Test API search (combines multiple methods)
    console.log('\n2️⃣ Testing API Search...');
    const apiResult = await apiSearch.execute({
      apiName: 'Stripe',
      includeAuth: true
    });
    
    if (apiResult.success) {
      console.log('✅ API search working');
      console.log('📄 Result preview:', apiResult.result.substring(0, 200) + '...');
    } else {
      console.log('❌ API search failed:', apiResult.error);
    }
    
  } catch (error) {
    console.error('❌ Test error:', error.message);
  }
}

if (require.main === module) {
  testSearchTools();
}
