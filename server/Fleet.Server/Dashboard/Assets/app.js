'use strict';
const $ = selector => document.querySelector(selector);
let csrf = '';
let nextCursor = null;
let enrollmentId = null;
let modelSelections = [];
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
      node_alias_changed: 'This Node was renamed. Refresh the list before removing it.',
      stale_selection: 'Another operator saved this selection. It was reloaded; review it and save again.',
      invalid_selection: 'This selection is invalid or would leave no models enabled.',
      catalog_unavailable: 'This model catalog is no longer available. Reload the selection.',
      pinned_model_excluded: 'A pinned default model cannot be excluded. Keep those models selected and save again.'
    };
    const failure = new Error(known[error.code] || `Request failed (${response.status}). Refresh and try again.`);
    failure.code = error.code; failure.status = response.status; failure.details = error;
    throw failure;
  }
  return response.json();
}
async function renewCsrf() { csrf = (await api('/csrf')).token; }
function clearLink() { $('#enrollment-link').value = ''; $('#link-result').hidden = true; enrollmentId = null; }
function showLogin() {
  $('#login-panel').hidden = false; $('#workspace').hidden = true; $('#logout').hidden = true;
  $('#actor').textContent = ''; $('#nodes').replaceChildren(); clearLink();
  $('#diagnostics-issues').replaceChildren(); $('#diagnostics-checked').textContent = '';
  $('#source-result').textContent = '';
  $('#models-result').textContent = ''; $('#model-catalogs').replaceChildren();
  $('#selection-result').textContent = ''; $('#model-selections').replaceChildren(); modelSelections = [];
}
async function showWorkspace(actor) {
  $('#login-panel').hidden = true; $('#workspace').hidden = false; $('#logout').hidden = false;
  $('#actor').textContent = actor; await renewCsrf(); await nodes(false);
  await diagnostics();
  await modelStatus().catch(error => { $('#models-result').textContent = error.message; });
  await loadModelSelections().catch(error => { $('#selection-result').textContent = error.message; });
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
    await diagnostics();
  } catch (error) {
    $('#source-result').textContent = error.message + ' Sync completion could not be confirmed.';
  } finally { button.disabled = false; }
});
async function diagnostics() {
  const button = $('#refresh-diagnostics');
  button.disabled = true;
  try {
    const result = await api('/diagnostics');
    const list = $('#diagnostics-issues'); list.replaceChildren();
    const count = result.issues.length;
    $('#diagnostics-count').textContent = String(count); $('#diagnostics-count').hidden = !count;
    $('#diagnostics-summary').textContent = count ? 'Configuration and sync problems that need your attention.' : 'No issues detected in configuration, model sync, repository sync or Agent check-ins.';
    for (const issue of result.issues) {
      const card = document.createElement('article'); card.className = 'diagnostic-issue ' + (issue.severity === 'error' ? 'issue-error' : 'issue-warning');
      const heading = document.createElement('div'); heading.className = 'issue-heading';
      const badge = document.createElement('span'); badge.className = 'issue-severity'; badge.textContent = issue.severity === 'error' ? 'Needs attention' : 'Check';
      const title = document.createElement('h3'); title.textContent = issue.title; heading.append(badge, title);
      const detail = document.createElement('p'); detail.textContent = issue.detail;
      const action = document.createElement('p'); action.className = 'issue-action'; action.textContent = issue.action;
      card.append(heading, detail, action);
      if (['models', 'repository', 'nodes-section'].includes(issue.section)) {
        const link = document.createElement('a'); link.href = '#' + issue.section;
        link.textContent = {models: 'View model sync', repository: 'View repository sync', 'nodes-section': 'View nodes'}[issue.section]; card.append(link);
      }
      list.append(card);
    }
    $('#diagnostics-checked').textContent = 'Checked ' + new Date(result.checkedAt).toLocaleString() + '. Status reflects the Server’s latest records.';
  } catch (error) {
    $('#diagnostics-summary').textContent = 'Could not check diagnostics. ' + error.message;
    $('#diagnostics-checked').textContent = 'Previous results may be out of date.';
  } finally { button.disabled = false; }
}
$('#refresh-diagnostics').addEventListener('click', diagnostics);
function showModels(status) {
  const seconds = status.intervalSeconds;
  const interval = seconds % 86400 === 0 ? `${seconds / 86400} day(s)` :
    seconds % 3600 === 0 ? `${seconds / 3600} hour(s)` : `${seconds} seconds`;
  $('#sync-models').disabled = !status.enabled;
  $('#models-result').textContent = !status.enabled ? 'Model sync is disabled. Configure the CLIProxy API key on the Server.' :
    !status.catalogs.length ? 'No active Nodes are assigned to CLIProxy. Enable a client in the repository and sync it first.' :
    `Automatic refresh every ${interval}. Agents fetch updated catalogs on their next poll.`;
  const list = $('#model-catalogs'); list.replaceChildren();
  for (const catalog of status.catalogs) {
    const item = document.createElement('li');
    const last = catalog.lastSuccess ? new Date(catalog.lastSuccess).toLocaleString() : 'never';
    const next = new Date(catalog.nextRefresh).toLocaleString();
    const error = catalog.errorCode ? ` Refresh failed (${catalog.errorCode}); ${catalog.modelCount ? 'keeping the previous catalog' : 'no catalog is available yet'}.` : '';
    item.textContent = `${catalog.baseUrl}: ${catalog.modelCount} models. Last successful refresh: ${last}. Next refresh: ${next}.${error}`;
    list.append(item);
  }
}
async function modelStatus() { showModels(await api('/cliproxy/status')); }
function familyBase(policy, familyKey) {
  if (policy.disabledFamilies.includes(familyKey)) return false;
  if (policy.enabledFamilies.includes(familyKey)) return true;
  return policy.includeNew;
}
function familyList(entry) {
  const groups = new Map();
  for (const model of entry.models) {
    const key = model.familyKey || 'other';
    if (!groups.has(key)) groups.set(key, { key, label: model.familyLabel || 'Other models', models: [] });
    groups.get(key).models.push(model);
  }
  return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label));
}
function effectiveSelection(entry, model) {
  if (typeof entry.policy.modelOverrides[model.id] === 'boolean') return entry.policy.modelOverrides[model.id];
  return familyBase(entry.policy, model.familyKey || 'other');
}
function policySnapshot(policy) {
  return JSON.stringify({
    includeNew: policy.includeNew,
    enabledFamilies: [...policy.enabledFamilies].sort(),
    disabledFamilies: [...policy.disabledFamilies].sort(),
    modelOverrides: Object.fromEntries(Object.entries(policy.modelOverrides).sort(([a], [b]) => a.localeCompare(b)))
  });
}
function selectionDirty(entry) { return policySnapshot(entry.policy) !== entry.savedPolicy; }
function renderModelSelections() {
  const container = $('#model-selections'); container.replaceChildren();
  if (!modelSelections.length) {
    const note = document.createElement('p'); note.className = 'muted'; note.textContent = 'No CLIProxy model catalogs are available yet.'; container.append(note); return;
  }
  for (const entry of modelSelections) {
    const card = document.createElement('article'); card.className = 'selection-card';
    const heading = document.createElement('div'); heading.className = 'selection-card-heading';
    const title = document.createElement('h4'); title.textContent = entry.baseUrl; heading.append(title);
    const count = document.createElement('span'); count.className = 'muted'; count.textContent = `${entry.models.filter(model => effectiveSelection(entry, model)).length} of ${entry.models.length} models selected`; heading.append(count);
    card.append(heading);
    const futureLabel = document.createElement('label'); futureLabel.className = 'future-models';
    const future = document.createElement('input'); future.type = 'checkbox'; future.checked = entry.policy.includeNew; future.dataset.selectionAction = 'include-new';
    futureLabel.append(future, document.createTextNode(' Enable newly discovered families by default'));
    const explanation = document.createElement('p'); explanation.className = 'muted'; explanation.textContent = 'New models in an enabled family follow its switch. Only families first discovered later use this default. Model checkboxes set exceptions.';
    card.append(futureLabel, explanation);
    const families = document.createElement('div'); families.className = 'selection-families';
    for (const family of familyList(entry)) {
      const box = document.createElement('fieldset'); box.className = 'selection-family';
      const legend = document.createElement('legend');
      const selected = family.models.filter(model => effectiveSelection(entry, model)).length;
      const switchLabel = document.createElement('label'); switchLabel.className = 'family-toggle';
      const toggle = document.createElement('input'); toggle.type = 'checkbox'; toggle.checked = familyBase(entry.policy, family.key);
      toggle.dataset.selectionAction = 'family'; toggle.dataset.family = family.key;
      switchLabel.append(toggle, document.createTextNode(` Sync ${family.label}`)); legend.append(switchLabel);
      const tally = document.createElement('span'); tally.className = 'muted'; tally.textContent = `${selected}/${family.models.length}`; legend.append(tally);
      box.append(legend);
      const modelList = document.createElement('div'); modelList.className = 'selection-model-list';
      for (const model of family.models) {
        const modelLabel = document.createElement('label'); modelLabel.className = 'model-choice';
        const input = document.createElement('input'); input.type = 'checkbox'; input.checked = effectiveSelection(entry, model); input.dataset.selectionAction = 'model'; input.dataset.model = model.id; input.dataset.family = family.key;
        modelLabel.append(input, document.createTextNode(model.id));
        if (model.reasoningLevels?.length) {
          const levels = document.createElement('span'); levels.className = 'muted'; levels.textContent = `Reasoning: ${model.reasoningLevels.join(', ')}`; modelLabel.append(levels);
        }
        modelList.append(modelLabel);
      }
      box.append(modelList); families.append(box);
    }
    card.append(families);
    const actions = document.createElement('div'); actions.className = 'selection-actions';
    const save = document.createElement('button'); save.textContent = 'Save selection'; save.disabled = !selectionDirty(entry) || entry.saving; save.dataset.selectionAction = 'save';
    const reset = document.createElement('button'); reset.className = 'secondary'; reset.textContent = 'Reset changes'; reset.disabled = !selectionDirty(entry) || entry.saving; reset.dataset.selectionAction = 'reset';
    actions.append(save, reset); card.append(actions); container.append(card);
  }
}
function editFamily(entry, key, enabled) {
  const disabled = new Set(entry.policy.disabledFamilies);
  const enabledFamilies = new Set(entry.policy.enabledFamilies);
  if (enabled) disabled.delete(key); else disabled.add(key);
  if (enabled) enabledFamilies.add(key); else enabledFamilies.delete(key);
  entry.policy.disabledFamilies = [...disabled];
  entry.policy.enabledFamilies = [...enabledFamilies];
  for (const model of entry.models.filter(item => (item.familyKey || 'other') === key)) {
    delete entry.policy.modelOverrides[model.id];
  }
}
function preserveVisibleFamilies(entry) {
  const enabled = new Set(entry.policy.enabledFamilies), disabled = new Set(entry.policy.disabledFamilies);
  for (const family of familyList(entry)) if (!enabled.has(family.key) && !disabled.has(family.key)) {
    (familyBase(entry.policy, family.key) ? enabled : disabled).add(family.key);
  }
  entry.policy.enabledFamilies = [...enabled]; entry.policy.disabledFamilies = [...disabled];
}
async function loadModelSelections() {
  $('#selection-result').textContent = 'Loading model selection…';
  const result = await api('/cliproxy/selection');
  modelSelections = result.catalogs.map(entry => {
    const policy = { includeNew: entry.policy.includeNew, enabledFamilies: [...(entry.policy.enabledFamilies || [])], disabledFamilies: [...entry.policy.disabledFamilies], modelOverrides: { ...entry.policy.modelOverrides } };
    return { ...entry, policy, savedPolicy: policySnapshot(policy) };
  });
  $('#selection-result').textContent = modelSelections.length ? '' : 'No model selections are available. Refresh models after assigning CLIProxy to an active Node.';
  renderModelSelections();
}
$('#refresh-selection').addEventListener('click', async () => {
  const button = $('#refresh-selection'); button.disabled = true;
  try { await loadModelSelections(); }
  catch (error) { $('#selection-result').textContent = error.message; }
  finally { button.disabled = false; }
});
$('#model-selections').addEventListener('change', event => {
  const control = event.target; const action = control.dataset.selectionAction;
  if (!action || action === 'save' || action === 'reset') return;
  const card = control.closest('.selection-card'); const index = [...$('#model-selections').children].indexOf(card); const entry = modelSelections[index];
  if (action === 'include-new') {
    preserveVisibleFamilies(entry);
    entry.policy.includeNew = control.checked;
  }
  else if (action === 'family') editFamily(entry, control.dataset.family, control.checked);
  else if (action === 'model') {
    const model = entry.models.find(item => item.id === control.dataset.model);
    if (control.checked === familyBase(entry.policy, control.dataset.family)) delete entry.policy.modelOverrides[model.id];
    else entry.policy.modelOverrides[model.id] = control.checked;
  }
  renderModelSelections();
});
$('#model-selections').addEventListener('click', async event => {
  const action = event.target.dataset.selectionAction;
  if (action !== 'save' && action !== 'reset') return;
  const card = event.target.closest('.selection-card'); const index = [...$('#model-selections').children].indexOf(card); const entry = modelSelections[index];
  if (action === 'reset') { entry.policy = JSON.parse(entry.savedPolicy); renderModelSelections(); return; }
  preserveVisibleFamilies(entry);
  entry.saving = true; renderModelSelections(); $('#selection-result').textContent = `Saving selection for ${entry.baseUrl}…`;
  try {
    const result = await api('/cliproxy/selection', { baseUrl: entry.baseUrl, version: entry.version, policy: entry.policy });
    const saved = result.catalog;
    const policy = { includeNew: saved.policy.includeNew, enabledFamilies: [...(saved.policy.enabledFamilies || [])], disabledFamilies: [...saved.policy.disabledFamilies], modelOverrides: { ...saved.policy.modelOverrides } };
    modelSelections[index] = { ...saved, policy, savedPolicy: policySnapshot(policy) };
    $('#selection-result').textContent = `Selection saved for ${entry.baseUrl}. Agents receive it on their next poll.`;
  } catch (error) {
    if (error.code === 'stale_selection' || error.code === 'catalog_unavailable') {
      const currentBaseUrl = entry.baseUrl;
      try { await loadModelSelections(); }
      catch (loadError) { $('#selection-result').textContent = `${error.message} Reload failed: ${loadError.message}`; return; }
      $('#selection-result').textContent = error.message;
      if (currentBaseUrl && !modelSelections.some(item => item.baseUrl === currentBaseUrl)) $('#selection-result').textContent += ' This catalog is no longer available.';
    } else {
      entry.saving = false; renderModelSelections();
      const blocked = error.code === 'pinned_model_excluded' && error.details.models?.length ? ` Pinned models: ${error.details.models.join(', ')}.` : '';
      $('#selection-result').textContent = error.message + blocked;
    }
  }
});
$('#sync-models').addEventListener('click', async () => {
  const button = $('#sync-models');
  if (button.disabled) return;
  button.disabled = true;
  $('#models-result').textContent = 'Fetching models from CLIProxy…';
  try { showModels(await api('/cliproxy/refresh', {})); await diagnostics(); }
  catch (error) { $('#models-result').textContent = error.message + ' Model refresh could not be confirmed.'; button.disabled = false; return; }
  await loadModelSelections().catch(error => { $('#selection-result').textContent = error.message; });
});
$('#refresh').addEventListener('click', () => Promise.all([nodes(false), modelStatus()]).catch(error => message(error.message)));
$('#more').addEventListener('click', () => nodes(true).catch(error => message(error.message)));
addEventListener('pagehide', () => { $('#operator-token').value = ''; clearLink(); });
(async () => {
  try { await renewCsrf(); const session = await api('/session'); await showWorkspace(session.actor); }
  catch (error) { if ($('#login-panel').hidden) message(error.message); }
})();
