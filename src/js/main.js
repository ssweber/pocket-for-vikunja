// Where Pocket's code starts: the build bundles this file, and everything it imports, into the page.
import {globals, pocket} from './component.js';

// The helpers the markup uses by name, as globals; then the component, once Alpine asks for it.
Object.assign(window, globals);
document.addEventListener('alpine:init', () => Alpine.data('pocket', pocket));
