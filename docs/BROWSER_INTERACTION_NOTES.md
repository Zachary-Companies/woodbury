# Browser Interaction Notes

## How to Successfully Interact with Webpages

These notes document the successful approach for interacting with web pages using the woodbury agent tools.

---

## Key Tools Used

### 1. `browser_query` — Primary Tool for Web Interaction

The **Woodbury Bridge Chrome extension** is the key enabler. When connected, it provides:
- Exact pixel coordinates of elements
- CSS selectors
- Element metadata (text, attributes, bounds)
- Real DOM access (not vision-based guessing)

**Always start with a ping to check connection:**
```
browser_query(action="ping")
```

### 2. `browser` — Window Control

Used for:
- Opening URLs: `browser(action="open", url="https://...", waitMs=5000)`
- Bringing Chrome to foreground: `browser(action="focus")`
- The `waitMs` parameter is crucial — wait for page load!

### 3. `mouse` — Click Actions

Used for clicking at specific coordinates:
```
mouse(action="click", x=96, y=157)
```

### 4. `keyboard` — Text Input

Used for typing text and pressing keys:
```
keyboard(action="type", text="your text here")
keyboard(action="press", key="enter")
```

---

## The Critical Workflow for Text Input

### Problem Discovered
When typing into a text field on a webpage from the terminal, the **focus** matters!

- The terminal has focus when the agent is running
- The webpage's text field needs focus to receive keystrokes
- Simply finding the element and typing doesn't work — you need to **switch focus**

### Solution: The Focus Sandwich

```
1. browser(action="focus")           # Switch focus TO Chrome
2. browser_query(action="click_element", selector="#input-field")  # Click the input to focus it
3. keyboard(action="type", text="...")  # Type the text
4. keyboard(action="press", key="enter") # Submit if needed
5. browser(action="focus", appName="Terminal")  # Return focus to Terminal
```

**This "focus sandwich" is essential for any text input workflow!**

---

## Successful Midjourney Interaction Example

### Steps that worked:

1. **Open the page:**
   ```
   browser(action="open", url="https://www.midjourney.com", waitMs=5000)
   ```

2. **Check extension connection:**
   ```
   browser_query(action="ping")
   ```

3. **Find the Create button using natural language:**
   ```
   browser_query(action="find_interactive", description="Create button")
   ```
   This returned ranked candidates with coordinates and context.

4. **Click the Create button:**
   ```
   browser_query(action="click_element", selector="a[href='/imagine']")
   ```
   Or use mouse with coordinates:
   ```
   mouse(action="click", x=96, y=157)
   ```

5. **Focus Chrome before typing:**
   ```
   browser(action="focus")
   ```

6. **Click the prompt textarea to focus it:**
   ```
   browser_query(action="click_element", selector="#desktop_input_bar")
   ```

7. **Type the prompt:**
   ```
   keyboard(action="type", text="a red corvette sports car...")
   ```

8. **Submit with Enter:**
   ```
   keyboard(action="press", key="enter")
   ```

9. **Return focus to Terminal:**
   ```
   browser(action="focus", appName="Terminal")
   ```

---

## Key Learnings

### 1. Always Use `browser_query` First
- It gives **exact** coordinates from the real DOM
- Much more reliable than vision-based guessing
- Use `find_interactive` with natural language descriptions

### 2. The Focus Problem
- Terminal and browser are different windows
- Keyboard input goes to the **focused** window
- Must explicitly switch focus with `browser(action="focus")`
- Must click the input field to focus it within the page

### 3. Wait Times Matter
- Use `waitMs` when opening URLs (pages need time to load)
- Use `delayMs` on mouse/keyboard actions (UI needs time to respond)
- Default 5000ms is usually safe for initial page load

### 4. Element Finding Strategy
```
browser_query(action="find_interactive", description="...")  # BEST - natural language
browser_query(action="find_element_by_text", text="...")     # Good for specific text
browser_query(action="get_clickable_elements")               # When exploring
browser_query(action="get_form_fields")                      # For forms
```

### 5. Click Strategy
```
# Preferred: Use selector (triggers proper DOM events)
browser_query(action="click_element", selector="#button-id")

# Fallback: Use coordinates
mouse(action="click", x=100, y=200)
```

### 6. Form Input Strategy
```
# For React/Vue/Angular apps, use set_value (handles virtual DOM):
browser_query(action="set_value", selector="input[name=email]", value="user@example.com")

# For simple forms or when set_value doesn't work:
1. Focus the window
2. Click the input
3. Use keyboard(action="type", ...)
```

---

## Debugging Tips

### If clicks don't work:
1. Check `browser_query(action="ping")` — is extension connected?
2. Use `browser_query(action="get_page_info")` — are you on the right page?
3. Use `browser_query(action="find_interactive", description="...")` — does the element exist?
4. Check if element is in viewport — may need `scroll_to_element`

### If typing doesn't work:
1. Did you focus Chrome? `browser(action="focus")`
2. Did you click the input field?
3. Is the input field disabled or readonly?
4. Try `browser_query(action="set_value", ...)` instead

### If extension isn't connected:
1. Check Chrome is running
2. Verify Woodbury Bridge extension is installed
3. The extension should auto-connect on page load
4. Try refreshing the page

---

## Template: Complete Form Fill Workflow

```python
# 1. Open page
browser(action="open", url="https://example.com/form", waitMs=5000)

# 2. Verify connection
browser_query(action="ping")

# 3. Get form fields
browser_query(action="get_form_fields")

# 4. Focus Chrome
browser(action="focus")

# 5. Fill each field
browser_query(action="click_element", selector="input[name=email]")
keyboard(action="type", text="user@example.com")

browser_query(action="click_element", selector="input[name=password]")
keyboard(action="type", text="secretpassword")

# 6. Submit
browser_query(action="click_element", selector="button[type=submit]")

# 7. Return focus
browser(action="focus", appName="Terminal")

# 8. Verify result
browser_query(action="get_page_info")
```

---

*Last updated: 2026-02-19*
*Context: Successfully entered Midjourney prompt by using the focus sandwich technique*
