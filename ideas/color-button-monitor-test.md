# Color Button Monitor Test

A simple web page with a single button that cycles through pure colors when clicked. Designed for quickly verifying monitor color reproduction, contrast, and pixel health.

## Core features
- One full-width button centered on the page
- Click cycles to the next color in sequence: red, green, blue, white, black, then repeat
- Current color name displayed as text label on the button
- Keyboard accessible: Space or Enter triggers the same cycle
- Pure color values: #FF0000, #00FF00, #0000FF, #FFFFFF, #000000

## Non-goals
- No calibration tools, no gradients, no animations
- No backend, no persistence, no settings
- Single HTML file, no build step, no dependencies
