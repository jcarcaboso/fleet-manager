'use strict';
const link = location.href;
history.replaceState(null, '', '/enroll');
const field = document.querySelector('#link');
const message = document.querySelector('#message');
if (link.length <= 16384 && new URL(link).hash.startsWith('#fleet-v1=')) {
  field.value = link;
} else {
  message.textContent = 'No enrollment link found. Ask your Operator for a new link.';
  document.querySelector('#copy').disabled = true;
}
document.querySelector('#copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(field.value); message.textContent = 'Copied. Paste it at the Agent prompt.'; }
  catch { field.select(); message.textContent = 'Select and copy the link manually.'; }
});
addEventListener('pagehide', () => { field.value = ''; });
