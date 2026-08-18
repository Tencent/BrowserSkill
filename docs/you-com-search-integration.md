# You.com Search Integration for BrowserSkill

BrowserSkill now includes optional You.com web search capability through the `bsk search` command, providing AI agents with additional context and research capabilities to inform their browser automation tasks.

## Overview

The You.com search integration allows AI agents to:
- Research topics before navigating to relevant websites
- Gather context about technologies, frameworks, or concepts
- Find relevant URLs to visit during browser automation
- Access real-time information to inform decision-making

## Usage

### Basic Search
```bash
# Search for general information
bsk search "Next.js deployment best practices"

# Get specific number of results
bsk search "React testing patterns" --count 5

# Search news specifically  
bsk search "AI development trends" --search-type news
```

### JSON Output (Agent-Friendly)
```bash
# Machine-readable output for agent processing
bsk search "JavaScript performance optimization" --json

# Combine with other bsk commands in agent workflows
bsk search "GitHub Actions CI/CD" --json --count 3 | jq '.results[0].url' | xargs bsk navigate
```

## Configuration

The search integration supports optional configuration via environment variables:

### YDC_API_KEY (Optional)
```bash
export YDC_API_KEY="your-you-com-api-key"
bsk search "advanced search query"
```

Without an API key, the integration works with You.com's public search endpoints (with potential rate limits).

### YDC_BASE_URL (Optional)
```bash
export YDC_BASE_URL="https://api.you.com"  # Default
bsk search "custom endpoint search"
```

## Options

- `--count <NUMBER>`: Results to return (default: 10, max: 20)
- `--search-type <TYPE>`: Search type - `search` (default) or `news`
- `--include-raw-content`: Include raw HTML content in results (larger response)
- `--json`: Machine-readable JSON output

## Integration with Agent Workflows

The search command is designed to enhance browser automation workflows:

1. **Research Phase**: Use `bsk search` to find relevant information
2. **Navigation**: Use URLs from search results with `bsk navigate`
3. **Context-Aware Actions**: Use search insights to inform page interactions

### Example Agent Workflow
```bash
# Agent searches for documentation
DOCS_URL=$(bsk search "React hooks documentation" --json --count 1 | jq -r '.results[0].url')

# Navigate to the documentation
bsk navigate "$DOCS_URL"

# Take screenshot of the page
bsk screenshot docs-reference.png

# Search within the page for specific information
bsk evaluate "document.querySelector('h2').textContent"
```

## Response Format

### Human-Readable Output
```
Search Results for: rust programming
Found 3 results:

1. Rust Programming Language
   https://rust-lang.org/
   The official Rust programming language website...

2. Rust Tutorial - W3Schools  
   https://www.w3schools.com/rust/
   Learn Rust with comprehensive tutorials...
```

### JSON Output
```json
{
  "results": [
    {
      "url": "https://rust-lang.org/",
      "title": "Rust Programming Language", 
      "snippet": "The official Rust programming language website..."
    }
  ],
  "query": "rust programming",
  "count": 3
}
```

## Error Handling

The search command handles various error conditions gracefully:

- **Network Issues**: Provides clear error messages for connectivity problems
- **API Errors**: Reports HTTP error codes and messages from You.com API
- **Invalid Parameters**: Validates input parameters (count limits, etc.)
- **Missing Dependencies**: Falls back to basic functionality when possible

## Performance Considerations

- Search requests are synchronous but typically complete in 1-3 seconds
- JSON responses are more compact for agent processing
- Raw content inclusion significantly increases response size
- Rate limiting may apply for unauthenticated requests

## Security

- API keys are passed via environment variables (not command line arguments)
- No sensitive information is logged in verbose output
- HTTPS is used for all API communication
- No persistent storage of search data