# Use Cases — REQ-001 Hex Button Autism UI Component Library

**Status:** Draft
**PRD:** docs/requirements/REQ-001-hex-button-autism-ui/00-PRD.md
**Epic:** REQ-001

---

## UC-1: Configure Reduced Motion

**Primary Actor:** End User with Motion Sensitivity
**Scope:** Button Component Library
**Level:** User Goal
**Derived from:** [FR-1: Configurable Reduced Motion](../00-PRD.md#FR-1)

### Story

As a user with motion sensitivity, I want to configure reduced motion settings for button animations so that I can interact with buttons without experiencing vestibular triggers or sensory overload from motion effects.

### Preconditions

- User has a modern web browser with ES6+ support
- Button library is installed in the application
- User's OS or browser has `prefers-reduced-motion` setting configured

### Main Flow

1. User encounters a button component in the application
2. System checks user's `prefers-reduced-motion` OS/browser setting via `window.matchMedia`
3. If reduced motion is preferred, system disables all non-essential animations:
   - Hover transitions fade instead of slide/grow
   - Active states use color changes only (no scale/transform)
   - Loading spinners use static indicators or linear, slow animations (< 2px/s)
   - Focus rings use immediate appearance (no grow/fade-in effects)
4. All button functionality remains intact (activation, state changes, callbacks)

### Alternative Flows

**a) No OS preference set:**
- System applies library's default motion settings
- Developer can override defaults via configuration API

**b) Programmatic override:**
- Developer can force reduced motion mode via component props
- Respects OS preference unless explicitly overridden

### Postconditions

- All button interactions respect motion sensitivity preferences
- No functionality is lost due to reduced motion settings
- Visual feedback remains clear without motion effects

### Special Requirements

- Must respond dynamically to OS preference changes during session
- Must maintain WCAG 2.2 AAA contrast without motion cues
- Must not break keyboard navigation or screen reader announcements

---

## UC-2: Adjust Visual Clarity Settings

**Primary Actor:** End User with Visual Processing Differences
**Scope:** Button Component Library
**Level:** User Goal
**Derived from:** [FR-2: Adjustable Visual Clarity](../00-PRD.md#FR-2)

### Story

As a user with visual processing differences, I want to adjust button visual clarity settings including border thickness and color contrast so that I can clearly distinguish button boundaries and states.

### Preconditions

- Button library is installed in the application
- Developer has enabled visual clarity configuration options
- User has access to application settings or developer console

### Main Flow

1. User or developer accesses visual clarity configuration
2. System provides controls for:
   - Border thickness (range: 1px to 4px, default: 2px)
   - Color contrast ratio (range: WCAG AA to AAA, default: AAA)
   - Background opacity (range: 0.7 to 1.0, default: 1.0)
3. User adjusts settings to their needs
4. System applies changes immediately to all button instances
5. System validates that all combinations meet minimum WCAG 2.2 AAA standards (7:1 for normal text)

### Alternative Flows

**a) Developer-set defaults:**
- Developer configures default visual clarity for all users
- Individual users can override if application allows

**b) Invalid combination:**
- System prevents combinations that would fall below WCAG AAA
- Shows validation error if custom theme breaks contrast rules

### Postconditions

- All buttons maintain WCAG 2.2 AAA contrast (7:1 minimum)
- Button boundaries are visually distinct from background
- Settings persist across sessions (if application implements storage)

### Special Requirements

- Must support both per-instance and global configuration
- Must validate contrast ratios in real-time
- Must not break layout when increasing border thickness

---

## UC-3: Navigate with Clear Focus Indicators

**Primary Actor:** Keyboard-Only User
**Scope:** Button Component Library
**Level:** User Goal
**Derived from:** [FR-3: Clear Focus Indicators](../00-PRD.md#FR-3), [FR-5: Comprehensive Keyboard Navigation](../00-PRD.md#FR-5)

### Story

As a keyboard-only user, I want to see unambiguous, high-contrast focus indicators on buttons so that I can clearly understand which element has focus and navigate efficiently.

### Preconditions

- User is navigating via keyboard (Tab, Shift+Tab)
- Button library is installed and properly configured
- Application follows WAI-ARIA keyboard navigation patterns

### Main Flow

1. User presses Tab to move focus to next button
2. System immediately displays focus indicator:
   - 3px solid outline with 3:1 contrast against background
   - Offset of 2px from button edge to avoid overlap
   - Color: system default or high-contrast override (e.g., bright blue on dark backgrounds)
3. User continues Tabbing; focus indicator moves to next button
4. Previous button's focus indicator disappears
5. User presses Enter or Space to activate focused button
6. Button executes its action while maintaining focus visibility

### Alternative Flows

**a) Focus trapped in component:**
- User presses Escape to exit component
- Focus returns to last element outside the component

**b) Custom focus indicator:**
- Developer can customize focus style via configuration
- Must still meet 3:1 contrast and 2px minimum thickness

### Postconditions

- Focus is always visible on the active element
- Focus indicators meet or exceed WCAG 2.2 AAA standards
- Focus order follows logical DOM sequence (unless modified by developer)

### Special Requirements

- Focus indicator must be visible on all background colors
- Focus indicator must not be obscured by other elements
- Must support high-contrast mode and OS focus preferences

---

## UC-4: Customize Sensory Feedback

**Primary Actor:** End User with Sensory Processing Differences
**Scope:** Button Component Library
**Level:** User Goal
**Derived from:** [FR-4: Configurable Sensory Feedback](../00-PRD.md#FR-4)

### Story

As a user with sensory processing differences, I want to independently control hover, active, and focus visual feedback so that I can reduce overwhelming visual stimulation while maintaining button functionality.

### Preconditions

- Button library is installed
- Sensory feedback configuration is enabled by developer
- User or developer has access to feedback settings

### Main Flow

1. User or developer accesses sensory feedback configuration
2. System provides independent controls for each state:
   - **Hover:** enable/disable, animation type (none/fade/slide/grow), intensity (low/medium/high)
   - **Active:** enable/disable, animation type, duration
   - **Focus:** enable/disable, style (outline/glow/both), thickness
3. User configures each state according to their sensory needs
4. System applies changes immediately to all button instances
5. User tests interactions; all button functions work without configured feedback

### Alternative Flows

**a) Minimal feedback mode:**
- User disables all non-essential feedback
- System keeps only required indicators (focus for keyboard navigation)

**b) Preset profiles:**
- System provides presets: "minimal", "balanced", "full"
- User can select preset and then fine-tune individual settings

### Postconditions

- Button core functionality works without any visual feedback
- Keyboard navigation remains functional even with hover/active disabled
- Configured settings persist across session (if application implements storage)

### Special Requirements

- Must allow complete disabling of hover/active feedback
- Must NOT allow disabling focus indicators (accessibility requirement)
- Must respect OS-level accessibility preferences as baseline

---

## UC-5: Navigate via Keyboard

**Primary Actor:** Keyboard-Only User
**Scope:** Button Component Library
**Level:** User Goal
**Derived from:** [FR-5: Comprehensive Keyboard Navigation](../00-PRD.md#FR-5), [RULE-4: WAI-ARIA Keyboard Navigation Patterns](../00-PRD.md#RULE-4)

### Story

As a keyboard-only user, I want to navigate and interact with all button functions using standard keyboard shortcuts so that I can use the application without a mouse or pointer device.

### Preconditions

- User relies on keyboard for navigation
- Button library is installed with proper ARIA markup
- Application implements logical tab order

### Main Flow

1. User presses Tab to move focus forward through buttons
2. User presses Shift+Tab to move focus backward
3. User presses Enter or Space to activate focused button
4. System executes button action (click handler, navigation, etc.)
5. User presses Escape to close modals or cancel actions (if applicable)
6. Focus moves logically through DOM order

### Alternative Flows

**a) Disabled button:**
- User tabs to disabled button
- Focus indicator appears but button does not activate on Enter/Space
- Screen reader announces "disabled" status

**b) Button in focus trap:**
- User tabs within modal or component
- Focus cycles through component elements
- User presses Escape to exit the trap

**c) Custom activation keys:**
- Developer can configure custom activation keys
- Must always support Enter and Space as defaults

### Postconditions

- All button functions are accessible via keyboard
- Focus follows predictable, logical order
- Disabled state is communicated and enforced for keyboard users

### Special Requirements

- Must follow WAI-ARIA Authoring Practices 1.2
- Must not trap focus in unexpected ways
- Must maintain visible focus indicator at all times during keyboard navigation

---

## UC-6: Use with Screen Reader

**Primary Actor:** Screen Reader User
**Scope:** Button Component Library
**Level:** User Goal
**Derived from:** [FR-6: Screen Reader Optimization](../00-PRD.md#FR-6), [RULE-5: ARIA Attribute State Synchronization](../00-PRD.md#RULE-5)

### Story

As a screen reader user, I want buttons to announce their purpose, current state, and available interactions clearly so that I can understand and interact with them effectively.

### Preconditions

- User has screen reader software (JAWS, NVDA, VoiceOver, TalkBack)
- Button library includes proper ARIA attributes
- Button text and labels are descriptive

### Main Flow

1. Screen reader encounters button in DOM
2. System provides semantic markup:
   - `<button>` element or `role="button"`
   - Accessible name via text content or `aria-label`
   - Current state: `aria-pressed`, `aria-expanded`, `aria-disabled`
3. Screen reader announces:
   - Button purpose (e.g., "Submit form, button")
   - Current state (e.g., "pressed", "not pressed", "disabled")
   - Available interactions (e.g., "Press Enter to activate")
4. User presses Enter or Space to activate
5. System updates ARIA attributes if state changes
6. Screen reader announces new state

### Alternative Flows

**a) Icon-only button:**
- System provides `aria-label` describing button action
- Example: "Search", "Close dialog", "Open menu"

**b) Toggle button:**
- System includes `aria-pressed` attribute
- Screen reader announces: "Mute, button, pressed" or "Mute, button, not pressed"

**c) Loading button:**
- System includes `aria-busy="true"` and updates accessible name
- Screen reader announces: "Submit, button, loading"

### Postconditions

- Screen reader users understand button purpose without visual context
- State changes are announced immediately
- Disabled buttons are not activated by screen reader commands

### Special Requirements

- Must dynamically update ARIA attributes when state changes
- Must support all major screen readers (JAWS, NVDA, VoiceOver, TalkBack)
- Must provide meaningful accessible names for icon-only buttons

---

## UC-7: Configure Component Defaults

**Primary Actor:** Developer
**Scope:** Button Component Library
**Level:** User Goal
**Derived from:** [FR-7: Component Behavior Configuration](../00-PRD.md#FR-7), [RULE-7: Default Accessibility Settings Consistency](../00-PRD.md#RULE-7)

### Story

As a developer integrating the button library, I want to configure default accessibility behaviors so that buttons consistently match my application's accessibility standards and user needs.

### Preconditions

- Developer is building a React 18+ application
- Button library is installed via npm
- Developer wants to set global defaults for all button instances

### Main Flow

1. Developer creates configuration object in app root
2. System provides configuration options for:
   - Reduced motion: boolean or 'respect-preference'
   - Visual clarity: border thickness, contrast level
   - Sensory feedback: hover/active/focus settings
   - Focus indicators: style, thickness, color
   - ARIA defaults: custom label patterns
3. Developer sets desired defaults
4. System applies defaults to all button instances unless explicitly overridden
5. Developer can override defaults on individual button instances

### Alternative Flows

**a) No defaults configured:**
- System uses library's built-in accessibility defaults
- All defaults meet WCAG 2.2 AAA standards

**b) Per-instance override:**
- Developer sets custom props on specific button
- System respects override while keeping other defaults

**c) Theme-based defaults:**
- Developer provides multiple configurations for different themes
- System switches defaults based on active theme

### Postconditions

- All button instances use configured defaults by default
- Defaults can be overridden per-instance when needed
- Configuration persists across app lifecycle

### Special Requirements

- Must provide TypeScript types for all configuration options
- Must validate that defaults meet accessibility minimums
- Must not allow disabling required accessibility features (focus indicators)

---

## UC-8: Install and Import Package

**Primary Actor:** Developer
**Scope:** Development Environment
**Level:** User Goal
**Derived from:** [FR-8: NPM Package Distribution](../00-PRD.md#FR-8), [RULE-8: Semantic Versioning Compatibility](../00-PRD.md#RULE-8)

### Story

As a developer using React 18+, I want to install the button library from npm and import components into my application so that I can start using accessible buttons immediately.

### Preconditions

- Developer has Node.js and npm installed
- Target project uses React 18.0 or higher
- Project has TypeScript or JavaScript build configuration

### Main Flow

1. Developer runs: `npm install @hex-autism-ui/button`
2. System installs package with dependencies from npm registry
3. Developer imports component: `import { HexButton } from '@hex-autism-ui/button'`
4. System provides TypeScript types automatically
5. Developer uses component in JSX: `<HexButton>Click me</HexButton>`
6. System renders accessible button with default settings

### Alternative Flows

**a) Yarn installation:**
- Developer runs: `yarn add @hex-autism-ui/button`
- System installs via Yarn registry

**b) Peer dependency warning:**
- System checks for React 18+ peer dependency
- Shows warning if React version is incompatible
- Developer upgrades React or accepts compatibility risk

**c) Tree-shaking setup:**
- System supports ES module imports for optimal bundle size
- Developer can import individual components if needed

### Postconditions

- Package is installed in node_modules with proper dependency resolution
- TypeScript types are available for autocomplete and type-checking
- Component renders correctly with accessibility features built-in

### Special Requirements

- Must follow semantic versioning (Major.Minor.Patch)
- Must maintain backward compatibility within major versions
- Must include proper TypeScript declaration files (.d.ts)
- Must document peer dependencies (React 18+)

---

## Traceability Summary

| Use Case | Derived From FR(s) | Covers Rules |
|----------|-------------------|--------------|
| UC-1: Configure Reduced Motion | FR-1 | RULE-1 |
| UC-2: Adjust Visual Clarity Settings | FR-2 | RULE-2 |
| UC-3: Navigate with Clear Focus Indicators | FR-3, FR-5 | RULE-2, RULE-3, RULE-4 |
| UC-4: Customize Sensory Feedback | FR-4 | RULE-6 |
| UC-5: Navigate via Keyboard | FR-5 | RULE-4 |
| UC-6: Use with Screen Reader | FR-6 | RULE-5 |
| UC-7: Configure Component Defaults | FR-7 | RULE-7 |
| UC-8: Install and Import Package | FR-8 | RULE-8 |
