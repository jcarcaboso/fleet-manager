/**
 * The dashboard styles, ported verbatim from the Server's dashboard `style.css` (every class name and rule kept, except
 * the `body:not(.app)` rules of the Server's /enroll page). The files are contiguous slices of that file, imported in its
 * order, because the cascade depends on it. Vite extracts them into one CSS file; no inline styles are needed anywhere.
 */
import './tokens.css';
import './base.css';
import './components.css';
import './layout.css';
import './pages.css';
import './overlays.css';
import './live.css';
import './accounts.css';
import './updates.css';
