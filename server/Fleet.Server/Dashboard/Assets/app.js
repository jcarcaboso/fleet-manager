'use strict';
const $ = selector => document.querySelector(selector);
let csrf = '';
let nextCursor = null;
let enrollmentId = null;
const message = text => { $('#message').textContent = text; };

async function api(path, body) {
  const response = await fetch('/dashboard/api' + path, {
    method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Fleet-CSRF': csrf },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (!response.ok) {
    if (response.status === 401) { showLogin(); throw new Error('Sign in with a valid Operator token.'); }
    const error = await response.json().catch(() => ({}));
    const known = {
      invalid_csrf: 'Your session changed. Refresh the page and try again.',
      node_alias_in_use: 'That alias is already in use.', invalid_node_name: 'Choose a nonblank alias of at most 200 characters.',
      invalid_alias: 'Choose a nonblank alias of at most 200 characters.', node_not_found: 'That node no longer exists.',
      node_revoked: 'That node has been revoked.', invalid_expiry: 'Choose an expiry between 1 and 60 minutes.',
      node_alias_changed: 'This Node was renamed. Refresh the list before removing it.'
    };
    throw new Error(known[error.code] || `Request failed (${response.status}). Refresh and try again.`);
  }
  return response.json();
}
async function renewCsrf() { csrf = (await api('/csrf')).token; }
function clearLink() { $('#enrollment-link').value = ''; $('#link-result').hidden = true; enrollmentId = null; }
function showLogin() {
  $('#login-panel').hidden = false; $('#workspace').hidden = true; $('#logout').hidden = true;
  $('#actor').textContent = ''; $('#nodes').replaceChildren(); clearLink();
  $('#source-result').textContent = '';
}
async function showWorkspace(actor) {
  $('#login-panel').hidden = true; $('#workspace').hidden = false; $('#logout').hidden = false;
  $('#actor').textContent = actor; await renewCsrf(); await nodes(false);
}
async function nodes(append) {
  const page = await api('/nodes' + (append && nextCursor ? '?after=' + encodeURIComponent(nextCursor) : ''));
  if (!append) $('#nodes').replaceChildren();
  for (const node of page.items) {
    const row = document.createElement('tr');
    for (const value of [node.name, node.revoked ? 'Revoked' : ({fresh: 'Online', stale: 'Stale', never_contacted: 'Not yet contacted'}[node.freshness] ?? 'Unknown'), node.lastContactAt ? new Date(node.lastContactAt).toLocaleString() : 'Not yet']) {
      const cell = document.createElement('td'); cell.textContent = value ?? '—'; row.append(cell);
    }
    const actions = document.createElement('td'); const rename = document.createElement('button');
    rename.textContent = 'Rename'; rename.className = 'secondary'; rename.disabled = Boolean(node.revoked);
    rename.addEventListener('click', async () => {
      const currentAlias = node.alias ?? node.name;
      const alias = prompt('New unique alias', currentAlias);
      if (alias === null || alias === currentAlias) return;
      try { await api('/nodes/rename', { currentAlias, alias }); message('Alias changed. Update its entry in fleet.yml too.'); await nodes(false); }
      catch (error) { message(error.message); }
    });
    const revoke = document.createElement('button');
    revoke.textContent = 'Revoke'; revoke.className = 'secondary'; revoke.disabled = Boolean(node.revoked);
    revoke.addEventListener('click', async () => {
      if (!confirm(`Revoke access for "${node.name}"? Its certificates will stop working. The Node record and installed files will remain.`)) return;
      revoke.disabled = true;
      try { await api('/nodes/' + encodeURIComponent(node.nodeId) + '/revoke', {}); message('Node access revoked. Stop its Agent on the machine.'); await nodes(false); }
      catch (error) { revoke.disabled = false; message(error.message); }
    });
    const remove = document.createElement('button');
    remove.textContent = 'Remove'; remove.className = 'secondary';
    remove.addEventListener('click', async () => {
      const alias = prompt(`Permanently remove "${node.name}" and its server credentials and assignment history? Its alias will be free. Audit history stays. This does not erase files on the machine. Stop its Agent and remove its fleet.yml entry unless you plan to enroll a replacement.\n\nType the exact alias to confirm:`);
      if (alias === null) return;
      if (alias !== node.name) { message('Alias did not match. Node was not removed.'); return; }
      remove.disabled = true;
      try { await api('/nodes/' + encodeURIComponent(node.nodeId) + '/remove', { alias }); message('Node removed. Its alias is available for a new enrollment.'); await nodes(false); }
      catch (error) { remove.disabled = false; message(error.message); }
    });
    actions.append(rename, document.createTextNode(' '), revoke, document.createTextNode(' '), remove);
    row.append(actions); $('#nodes').append(row);
  }
  nextCursor = page.nextCursor;
  $('#more').hidden = !nextCursor; $('#nodes-empty').hidden = $('#nodes').children.length !== 0;
}
$('#login-form').addEventListener('submit', async event => {
  event.preventDefault(); const input = $('#operator-token'); const token = input.value; input.value = '';
  try { const result = await api('/login', { token }); message(''); await showWorkspace(result.actor); }
  catch (error) { message(error.message); await renewCsrf().catch(() => {}); }
});
$('#logout').addEventListener('click', async () => {
  try { await api('/logout', {}); showLogin(); await renewCsrf(); message('Signed out.'); }
  catch (error) { message(error.message); }
});
$('#enrollment-form').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    const result = await api('/enrollment-links', { alias: $('#alias').value.trim(), expiresInSeconds: Number($('#expiry').value) });
    enrollmentId = result.id; $('#enrollment-link').value = result.link; $('#link-result').hidden = false;
    $('#link-expiry').textContent = 'Expires ' + new Date(result.expiresAt).toLocaleString(); message('Enrollment link created.');
  } catch (error) { message(error.message); }
});
$('#copy-link').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('#enrollment-link').value); message('Link copied.'); }
  catch { $('#enrollment-link').select(); message('Select and copy the link manually.'); }
});
$('#clear-link').addEventListener('click', clearLink);
$('#revoke-link').addEventListener('click', async () => {
  if (!enrollmentId) return;
  try { await api('/enrollment-links/' + encodeURIComponent(enrollmentId) + '/revoke', {}); clearLink(); message('Enrollment link revoked.'); }
  catch (error) { message(error.message); }
});
$('#sync-source').addEventListener('click', async () => {
  const button = $('#sync-source');
  if (button.disabled) return;
  button.disabled = true;
  $('#source-result').textContent = 'Fetching and validating repository changes…';
  try {
    const result = await api('/source/rescan', {});
    const outcomes = {
      accepted: `Repository synced. Published ${result.changedAssignmentCount} changed assignment(s). Running Agents will fetch them on their next poll.`,
      unchanged: 'Repository is up to date. No new assignments were needed. Agents continue syncing their current assignments.',
      disabled: 'No source repository is configured on this server.',
      already_running: 'A repository sync is already running. Try again shortly to check for changes.',
      invalid: 'Repository sync was rejected. Check source diagnostics with the Operator API. Current assignments remain active.',
      failed: 'Repository sync failed. Check the server source status and Git access. Current assignments remain active.'
    };
    $('#source-result').textContent = outcomes[result.outcome] || 'The server returned an unknown sync result. Check source status before retrying.';
  } catch (error) {
    $('#source-result').textContent = error.message + ' Sync completion could not be confirmed.';
  } finally { button.disabled = false; }
});
$('#refresh').addEventListener('click', () => nodes(false).catch(error => message(error.message)));
$('#more').addEventListener('click', () => nodes(true).catch(error => message(error.message)));
addEventListener('pagehide', () => { $('#operator-token').value = ''; clearLink(); });
(async () => {
  try { await renewCsrf(); const session = await api('/session'); await showWorkspace(session.actor); }
  catch (error) { if ($('#login-panel').hidden) message(error.message); }
})();
