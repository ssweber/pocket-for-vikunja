// Where Pocket's code starts: the build bundles this file, and everything it imports, into the page.
import {directives, globals, pocket} from './component.js';

// The helpers the markup uses by name, as globals; then the markup's own directives (x-style, x-grow, x-box) and the
// component, once Alpine asks for them.
Object.assign(window, globals);
document.addEventListener('alpine:init', () => { directives(Alpine); Alpine.data('pocket', pocket); });
