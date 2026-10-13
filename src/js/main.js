// Where Pocket's code starts. The build bundles this file and everything it imports into the page.
import {directives, globals, pocket} from './component.js';

// The markup calls these helpers by name, so they go on window. The directives and the component are registered when
// Alpine starts.
Object.assign(window, globals);
document.addEventListener('alpine:init', () => { directives(Alpine); Alpine.data('pocket', pocket); });
