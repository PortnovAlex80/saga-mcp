# Business Rules: Accessible Counter Web Application

**Status:** draft
**Epic:** REQ-001
**Derived from PRD:** docs/requirements/REQ-001-accessible-counter/01-PRD.md

## RULE-1: Counter Value Range

The counter shall accept integer values within the safe integer range of JavaScript.

### Rule definition
- Counter values are integers
- Minimum value: No explicit minimum (practical limit: Number.MIN_SAFE_INTEGER)
- Maximum value: No explicit maximum (practical limit: Number.MAX_SAFE_INTEGER)
- Application does not enforce business-specific limits on counter range

### Rationale
As a reference implementation and simple utility, the counter demonstrates basic numeric operations without arbitrary business constraints. Users are responsible for practical usage within their context. This rule establishes the expected behavior while acknowledging the technical boundaries of JavaScript's number representation.

## RULE-2: Storage Graceful Degradation

When client-side storage is unavailable, the application shall continue to function with session-only persistence.

### Rule definition
- If localStorage is unavailable (quota exceeded, privacy settings, disabled), application detects this condition
- Application continues to operate with in-memory storage for the current session
- No error messages or alerts shown to the user
- Functionality remains available for the current page session

### Rationale
Ensures the application remains usable even when browser security policies or user preferences prevent persistent storage. This maintains accessibility and usability principles by prioritizing functional availability over persistent state. The graceful degradation approach ensures no user-facing errors or barriers to access.