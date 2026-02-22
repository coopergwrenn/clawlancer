# Browser Automation Patterns Reference

## Browser Tool API Reference

The `browser` tool provides full headless Chromium control via MCP (Model Context Protocol). Each action maps to a Puppeteer operation on the VM.

### navigate

Go to a URL. Waits for the page `load` event before returning.

```
browser → navigate(url="https://example.com")
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `url` | string | Yes | Full URL to navigate to (must include https://) |
| `launchOptions` | object | No | Puppeteer LaunchOptions. Default null. If changed, browser restarts. |

Notes:
- HTTP URLs are automatically upgraded to HTTPS
- Default timeout: 30 seconds
- Returns page title on success
- If the page redirects, the final URL is loaded

### screenshot

Capture the visible viewport or a specific element.

```
browser → screenshot(name="my-capture")
browser → screenshot(name="hero-section", selector=".hero", width=1280, height=900)
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Descriptive name for the screenshot |
| `selector` | string | No | CSS selector to capture a specific element |
| `width` | number | No | Viewport width in pixels (default: 800) |
| `height` | number | No | Viewport height in pixels (default: 600) |
| `encoded` | boolean | No | If true, return base64 data URI instead of binary (default: false) |

### click

Click an element identified by CSS selector.

```
browser → click(selector="button.submit")
browser → click(selector="#nav-menu > li:nth-child(3) a")
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `selector` | string | Yes | CSS selector for the element to click |

Notes:
- Waits for the element to be visible before clicking
- Throws error if element not found within timeout
- Triggers all standard DOM events (mousedown, mouseup, click)

### fill

Type text into an input field. Clears existing content first.

```
browser → fill(selector="input[name='email']", value="user@example.com")
browser → fill(selector="textarea#comments", value="Multi-line\ntext here")
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `selector` | string | Yes | CSS selector for the input field |
| `value` | string | Yes | Text to type into the field |

Notes:
- Focuses the element, clears it, then types the value
- Triggers input, change, and keypress events
- Works with `<input>`, `<textarea>`, and contenteditable elements

### select

Choose an option from a `<select>` dropdown.

```
browser → select(selector="select#country", value="US")
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `selector` | string | Yes | CSS selector for the `<select>` element |
| `value` | string | Yes | The `value` attribute of the `<option>` to select |

### hover

Move the mouse over an element (useful for revealing tooltips or dropdown menus).

```
browser → hover(selector=".dropdown-trigger")
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `selector` | string | Yes | CSS selector for the element to hover |

### evaluate

Execute arbitrary JavaScript in the page context. This is the most powerful action.

```
browser → evaluate(script="document.title")
browser → evaluate(script="JSON.stringify(performance.timing)")
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `script` | string | Yes | JavaScript code to execute in the browser |

Returns: The serialized return value of the script.

### snapshot

Get an accessible tree of page elements with refs for targeting. Useful for understanding page structure without taking a full screenshot.

```
browser → snapshot(refs="aria")
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `refs` | string | No | Reference type: `"aria"` (accessibility refs) or `"role"` (role-based refs). Default: `"aria"` |

Returns: An accessible tree of page elements. Each element has a ref (e.g., `"e12"`) that can be used for clicking, typing, etc. via CSS selector or ref-based targeting.

**When to use snapshot:**
- Understanding complex page layouts before interacting
- Finding the right element to click/fill when CSS selectors are unreliable
- Pages with dynamic IDs or deeply nested components
- Accessibility audits

### console

Read browser console logs. Useful for debugging JavaScript errors, monitoring network activity, or capturing app-level logging.

```
browser → console(level="info")
browser → console(level="error")
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `level` | string | No | Filter by log level: `"info"`, `"error"`, `"warning"`. Default: all levels |

Returns: Array of console log entries with timestamp, level, and message.

**When to use console:**
- Debugging JavaScript errors on a page
- Checking for failed API calls or network errors
- Monitoring application state changes
- Verifying that custom scripts executed correctly

## CDP (Chrome DevTools Protocol) Notes

The browser tool communicates with Chromium via CDP under the hood. Key things to know:

- **Single page context.** Each `evaluate` runs in the main frame. To access iframes, you must navigate into them via JS.
- **Serialization.** Return values are JSON-serialized. DOM nodes cannot be returned directly — extract their text/attributes instead.
- **Async support.** You can use `await` in evaluate scripts. The tool handles the async wrapper.
- **Console output.** `console.log` inside evaluate does not surface to the agent. Use return values instead.
- **Security context.** Scripts run with the page's origin. Cross-origin restrictions apply.

```
// WRONG — returns undefined (DOM nodes are not serializable)
document.querySelector('.title')

// RIGHT — returns the text content as a string
document.querySelector('.title')?.textContent?.trim()
```

## Cookie & Session Management

### How Sessions Work

- A browser session starts when the first `navigate` action is called
- Cookies persist across navigations within the same session
- Sessions timeout after 5 minutes of inactivity
- When a session ends, all cookies and local storage are cleared
- Each new conversation starts a fresh session (no persistence)

### Cookie Patterns

```javascript
// Read all cookies for current domain
evaluate("document.cookie")

// Check if logged in (common pattern)
evaluate("document.cookie.includes('session_id')")

// Read localStorage
evaluate("JSON.stringify(localStorage)")

// Check auth state via DOM
evaluate("!!document.querySelector('.user-avatar, .logout-btn')")
```

### Session Tips

- Do NOT rely on sessions persisting between conversations
- If a login flow is needed, it must be repeated each session
- Cookie-consent banners: click "Accept" before proceeding with the task
- Some sites set cookies via JS after page load — wait 1-2 seconds after navigate

## Screenshot Best Practices

### Viewport Sizes

| Use Case | Width | Height | Notes |
|----------|-------|--------|-------|
| Desktop default | 1280 | 900 | Standard laptop viewport |
| Mobile simulation | 375 | 812 | iPhone-like viewport |
| Tablet | 768 | 1024 | iPad-like viewport |
| Full-width desktop | 1920 | 1080 | Full HD monitor |
| Social media card | 1200 | 630 | OG image dimensions |
| Narrow element | 800 | 600 | Tool default, good for most tasks |

### Element-Specific Screenshots

```
// Capture just the navigation bar
screenshot(selector="nav.main-nav")

// Capture a specific chart or image
screenshot(selector="#revenue-chart")

// Capture a modal/dialog
screenshot(selector=".modal-content, [role='dialog']")

// Capture the first article card
screenshot(selector="article:first-of-type")
```

### Screenshot Naming Conventions

Use descriptive, hyphenated names:
- `stripe-pricing-page`
- `competitor-homepage-mobile`
- `search-results-react-hooks`
- `login-form-error-state`
- `product-comparison-table`

## JavaScript Evaluation Patterns

### DOM Queries — Data Extraction

```javascript
// Extract all links on a page
Array.from(document.querySelectorAll('a[href]'))
  .map(a => ({ text: a.textContent.trim(), url: a.href }))
  .filter(l => l.text.length > 0)
  .slice(0, 50)

// Extract a table as JSON
Array.from(document.querySelectorAll('table tbody tr')).map(row => {
  const cells = row.querySelectorAll('td, th');
  return Array.from(cells).map(c => c.textContent.trim());
})

// Extract meta tags (title, description, OG data)
({
  title: document.title,
  description: document.querySelector('meta[name="description"]')?.content,
  ogTitle: document.querySelector('meta[property="og:title"]')?.content,
  ogImage: document.querySelector('meta[property="og:image"]')?.content,
  canonical: document.querySelector('link[rel="canonical"]')?.href
})

// Extract all headings for page structure
Array.from(document.querySelectorAll('h1, h2, h3')).map(h => ({
  level: h.tagName,
  text: h.textContent.trim()
}))

// Get page text content (cleaned)
document.body.innerText.substring(0, 5000)
```

### Waiting for Elements

```javascript
// Wait for a specific element to appear (with timeout)
await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('Timeout')), 10000);
  const check = setInterval(() => {
    if (document.querySelector('.target-element')) {
      clearInterval(check);
      clearTimeout(timeout);
      resolve();
    }
  }, 500);
});

// Wait for network idle (rough approximation)
await new Promise(resolve => setTimeout(resolve, 3000));

// Wait for specific text to appear
await new Promise((resolve) => {
  const check = setInterval(() => {
    if (document.body.innerText.includes('Results loaded')) {
      clearInterval(check);
      resolve();
    }
  }, 500);
  setTimeout(() => { clearInterval(check); resolve(); }, 10000);
});
```

### Scrolling

```javascript
// Scroll to bottom (for infinite scroll pages)
window.scrollTo(0, document.body.scrollHeight);

// Scroll by a specific amount
window.scrollBy(0, 800);

// Scroll element into view
document.querySelector('.target').scrollIntoView({ behavior: 'smooth' });

// Infinite scroll pattern: scroll + wait + extract, repeat
async function scrollAndCollect(selector, maxItems) {
  let items = [];
  while (items.length < maxItems) {
    const newItems = Array.from(document.querySelectorAll(selector))
      .map(el => el.textContent.trim());
    items = [...new Set([...items, ...newItems])];
    window.scrollBy(0, 800);
    await new Promise(r => setTimeout(r, 1500));
    // Break if no new items after scroll
    if (newItems.length === items.length) break;
  }
  return items.slice(0, maxItems);
}
```

## Error Handling Patterns

### Element Not Found

When a CSS selector fails, the tool throws an error. Handle it gracefully:

```
Approach 1: Try multiple selectors
  browser → click(selector="button.submit")
  If error → browser → click(selector="input[type='submit']")
  If error → browser → click(selector="form button:last-of-type")

Approach 2: Verify element exists via evaluate first
  browser → evaluate("!!document.querySelector('button.submit')")
  If true → browser → click(selector="button.submit")
  If false → screenshot and report to user
```

### Page Load Timeout

If `navigate` times out (30s):
1. Try again once (transient network issue)
2. If second attempt fails, report to user
3. Do NOT retry more than twice

### JavaScript Errors in Evaluate

```
Approach: Wrap in try-catch
  browser → evaluate("
    try {
      // your extraction logic
      return Array.from(document.querySelectorAll('.item')).map(...)
    } catch (e) {
      return { error: e.message }
    }
  ")
```

### Stale Elements After Navigation

After clicking a link that triggers navigation, previous selectors may be invalid:
1. Wait for the new page to load (check URL or title change)
2. Re-query elements on the new page
3. Do not reuse element references from the previous page

## Performance Tips

### Wait Strategies

| Strategy | When to Use | How |
|----------|-------------|-----|
| Fixed delay | Simple pages, after click | `evaluate("await new Promise(r => setTimeout(r, 2000))")` |
| Element wait | SPA content loading | Poll for element with `setInterval` |
| Text wait | Content appears dynamically | Poll `innerText` for expected string |
| Network idle | After form submission | Fixed 3s delay (rough but effective) |

### Reducing Browser Actions

- Combine multiple `evaluate` calls into one when extracting multiple pieces of data
- Extract all data on a page in a single `evaluate` rather than multiple calls
- Use `web_fetch` first — only open browser if fetch fails
- Take one comprehensive screenshot instead of multiple partial ones

### Parallel vs Sequential

- Browser actions are inherently sequential (one page at a time)
- Use `web_search` and `web_fetch` for parallel data gathering
- Plan the navigation path to minimize page loads
- Extract everything needed from a page before navigating away

### Memory and Resource Awareness

- Browser sessions consume ~200-300MB RAM on the VM
- Long sessions with many navigations can accumulate memory
- Close sessions when done (they auto-close after 5min idle)
- Avoid opening unnecessary pages
- Keep `evaluate` scripts focused — do not load large datasets into memory
