<script setup lang="ts">
import { computed, ref } from 'vue';
import { ApiError } from '@/api/client';
import type { Account, AccountList, Scope } from '@/api/types';
import Avatar from '@/components/Avatar.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import EmptyState from '@/components/EmptyState.vue';
import ErrorState from '@/components/ErrorState.vue';
import Icon from '@/components/Icon.vue';
import LoadingBlock from '@/components/LoadingBlock.vue';
import LockNote from '@/components/LockNote.vue';
import Modal from '@/components/Modal.vue';
import PageHead from '@/components/PageHead.vue';
import ScopeGate from '@/components/ScopeGate.vue';
import StatusPill from '@/components/StatusPill.vue';
import { useLoad } from '@/composables/useLoad';
import { useView } from '@/composables/useView';
import { useFleet } from '@/context';
import { fmtFull, rel } from '@/lib/format';

/**
 * Dashboard accounts (admin). API: GET accounts; POST accounts { name, password, scope }; POST accounts/{name}/scope { scope };
 * POST accounts/{name}/password { password }; POST accounts/{name}/delete. A new account, and one whose password an admin set, must
 * choose its own password at the next sign-in. Every change ends the account's open sessions. Passwords stay in the dialog's field
 * and are cleared once posted.
 */
const { api, session, shell, toasts } = useFleet();

const SCOPES: Array<{ value: Scope; label: string; text: string }> = [
  { value: 'read', label: 'Read', text: 'Can view everything. Cannot change anything.' },
  { value: 'operate', label: 'Operate', text: 'Can retry, sync, refresh and acknowledge or snooze problems.' },
  { value: 'admin', label: 'Admin', text: 'Can change anything, including accounts.' },
];
const MIN_PASSWORD = 10;
/* Like the Server: it starts with a letter or digit, so a name is never "." or "..", which a URL would read as a path segment. */
const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const view = useView();
const { data, error, loading, reload, run } = useLoad(async token => {
  if (!session.can('admin')) return [] as Account[];
  const r = await api.get<AccountList>('accounts', undefined, { signal: token.signal });
  shell.markLoaded();
  return r.items.slice().sort((a, b) => a.name.localeCompare(b.name));
}, { view });
const accounts = computed(() => data.value ?? []);
const admins = computed(() => accounts.value.filter(a => a.scope === 'admin').length);
const isMe = (a: Account): boolean => a.name === session.state.actor;
const path = (a: Account, action: string): string => `accounts/${encodeURIComponent(a.name)}/${action}`;

/* A stale list (another admin deleted the account) refreshes itself. */
function failed(e: unknown, title: string): string {
  if (e instanceof ApiError && e.code === 'account_not_found') void run({ quiet: true });
  if (e instanceof ApiError && e.silent) return '';
  toasts.fail(e, title);
  return e instanceof Error ? e.message : title;
}

/* ------------------------------------------------------------------ add */
const adding = ref(false);
const addName = ref('');
const addScope = ref<Scope>('read');
const addPassword = ref<HTMLInputElement | null>(null);
const addError = ref<string | null>(null);
const addBusy = ref(false);
function openAdd(): void {
  addName.value = '';
  addScope.value = 'read';
  addError.value = null;
  adding.value = true;
}
async function submitAdd(): Promise<void> {
  if (addBusy.value) return;
  const name = addName.value.trim().toLowerCase();
  const password = addPassword.value?.value ?? '';
  if (!NAME.test(name)) { addError.value = 'Use 1 to 64 letters, digits, dots, dashes or underscores for the name, starting with a letter or digit.'; return; }
  if (accounts.value.some(a => a.name === name)) { addError.value = 'An account with that name already exists.'; return; }
  if (password.length < MIN_PASSWORD || password.length > 256) { addError.value = `Choose a first password of ${MIN_PASSWORD} to 256 characters.`; return; }
  addBusy.value = true;
  addError.value = null;
  try {
    await api.post<Account>('accounts', { name, password, scope: addScope.value });
    if (addPassword.value) addPassword.value.value = '';
    adding.value = false;
    toasts.push('Account added', { text: `${name} chooses a new password at the first sign-in.` });
    await run({ quiet: true });
  } catch (e) {
    addError.value = e instanceof Error ? e.message : 'The account could not be added.';
  } finally {
    addBusy.value = false;
  }
}

/* ------------------------------------------------------------------ scope */
const savingScope = ref<string | null>(null);
async function changeScope(a: Account, event: Event): Promise<void> {
  const select = event.target as HTMLSelectElement;
  const scope = select.value as Scope;
  if (scope === a.scope) return;
  savingScope.value = a.name;
  try {
    await api.post<Account>(path(a, 'scope'), { scope });
    toasts.push('Scope changed', { text: `${a.name} now has ${scope} access.` });
    await run({ quiet: true });
  } catch (e) {
    select.value = a.scope;
    failed(e, 'Could not change the scope');
  } finally {
    savingScope.value = null;
  }
}

/* ------------------------------------------------------------------ set password */
const resetting = ref<Account | null>(null);
const resetPassword = ref<HTMLInputElement | null>(null);
const resetError = ref<string | null>(null);
const resetBusy = ref(false);
function openReset(a: Account): void {
  resetError.value = null;
  resetting.value = a;
}
async function submitReset(): Promise<void> {
  const a = resetting.value;
  if (!a || resetBusy.value) return;
  const password = resetPassword.value?.value ?? '';
  if (password.length < MIN_PASSWORD || password.length > 256) { resetError.value = `Choose a password of ${MIN_PASSWORD} to 256 characters.`; return; }
  resetBusy.value = true;
  resetError.value = null;
  try {
    await api.post<Account>(path(a, 'password'), { password });
    if (resetPassword.value) resetPassword.value.value = '';
    resetting.value = null;
    toasts.push('Password set', { text: `${a.name} chooses a new password at the next sign-in.` });
    await run({ quiet: true });
  } catch (e) {
    resetError.value = failed(e, 'Could not set the password') || null;
    if (e instanceof ApiError && e.code === 'account_not_found') resetting.value = null;
  } finally {
    resetBusy.value = false;
  }
}

/* ------------------------------------------------------------------ delete */
const deleting = ref<Account | null>(null);
const deleteError = ref<string | null>(null);
const deleteBusy = ref(false);
function openDelete(a: Account): void {
  deleteError.value = null;
  deleting.value = a;
}
async function confirmDelete(): Promise<void> {
  const a = deleting.value;
  if (!a || deleteBusy.value) return;
  deleteBusy.value = true;
  try {
    await api.post(path(a, 'delete'), {});
    deleting.value = null;
    toasts.push('Account deleted', { text: `${a.name} can no longer sign in.` });
    await run({ quiet: true });
  } catch (e) {
    deleteError.value = e instanceof Error ? e.message : 'The account could not be deleted.';
    if (e instanceof ApiError && e.code === 'account_not_found') { deleting.value = null; void run({ quiet: true }); }
  } finally {
    deleteBusy.value = false;
  }
}

const deleteBlocked = (a: Account): string | null =>
  isMe(a) ? 'You cannot delete the account you are signed in with.' : a.scope === 'admin' && admins.value <= 1 ? 'At least one admin account must remain.' : null;
const scopeLocked = (a: Account): boolean => a.scope === 'admin' && admins.value <= 1;
</script>

<template>
  <ScopeGate level="admin">
    <LoadingBlock v-if="loading" />
    <div v-else class="wrap">
      <ErrorState v-if="error" :error="error" what="Accounts" @retry="reload()" />
      <template v-else-if="data">
        <PageHead title="Accounts" sub="People who can sign in to this dashboard. Fleet CLI tokens are configured on the Server and are not listed here.">
          <template #actions>
            <button type="button" class="btn btn-secondary" data-act="reload" @click="reload()"><Icon name="sync" />Refresh</button>
            <button type="button" class="btn btn-primary" data-act="add-account" @click="openAdd()"><Icon name="plus" />Add account</button>
          </template>
        </PageHead>
        <section class="panel">
          <EmptyState v-if="!accounts.length" icon="key" title="No accounts" text="Add an account so someone can sign in." />
          <div v-else class="tbl-wrap">
            <table class="tbl tbl--accounts">
              <thead><tr><th>Account</th><th>Scope</th><th>Password</th><th>Changed</th><th><span class="sr">Actions</span></th></tr></thead>
              <tbody id="accounts-body">
                <tr v-for="a in accounts" :key="a.name" :data-account="a.name">
                  <td><span class="who"><Avatar :name="a.name" /><span><b>{{ a.name }}</b><span v-if="isMe(a)" class="muted small">You</span></span></span></td>
                  <td>
                    <label class="sel sel--inline">
                      <span class="sr">Scope of {{ a.name }}</span>
                      <select
                        :value="a.scope"
                        :disabled="savingScope === a.name || scopeLocked(a)"
                        :data-tip="scopeLocked(a) ? 'At least one admin account must remain.' : undefined"
                        @change="changeScope(a, $event)"
                      >
                        <option v-for="s in SCOPES" :key="s.value" :value="s.value">{{ s.label }}</option>
                      </select>
                      <Icon name="chevD" class="sel-chev" />
                    </label>
                  </td>
                  <td>
                    <StatusPill v-if="a.mustChangePassword" level="warning" kind="bang" label="Must change at sign-in" />
                    <span v-else class="muted">Set by the user</span>
                  </td>
                  <td><span class="when"><b>{{ rel(a.updatedAt) }}</b><span class="muted small">{{ fmtFull(a.updatedAt) }}</span></span></td>
                  <td class="acct-actions">
                    <button type="button" class="btn btn-ghost btn-sm" :data-act="`password-${a.name}`" @click="openReset(a)"><Icon name="key" />Set password</button>
                    <button
                      type="button"
                      class="btn btn-ghost btn-sm"
                      :class="{ 'is-locked': deleteBlocked(a) }"
                      :aria-disabled="deleteBlocked(a) ? 'true' : undefined"
                      :data-tip="deleteBlocked(a) ?? undefined"
                      :data-act="`delete-${a.name}`"
                      @click="deleteBlocked(a) ? toasts.push('Not available', { tone: 'warning', text: deleteBlocked(a)! }) : openDelete(a)"
                    ><Icon name="trash" />Delete</button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <ul class="ticks acct-scopes">
            <li v-for="s in SCOPES" :key="s.value"><span><b>{{ s.label }}</b> — {{ s.text }}</span></li>
          </ul>
        </section>
      </template>
    </div>

    <Modal v-if="adding" title="Add account" subtitle="The person chooses their own password at the first sign-in." icon="plus" :persistent="addBusy" @close="adding = false">
      <form id="add-account-form" class="form" novalidate @submit.prevent="submitAdd">
        <label for="account-name">Name</label>
        <input id="account-name" v-model="addName" class="input" type="text" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="64" data-autofocus>
        <label for="account-scope">Scope</label>
        <label class="sel sel--block">
          <select id="account-scope" v-model="addScope">
            <option v-for="s in SCOPES" :key="s.value" :value="s.value">{{ s.label }} — {{ s.text }}</option>
          </select>
          <Icon name="chevD" class="sel-chev" />
        </label>
        <label for="account-password">First password</label>
        <input id="account-password" ref="addPassword" class="input" type="password" autocomplete="new-password" spellcheck="false" maxlength="256" aria-describedby="account-msg">
        <p id="account-msg" class="field-msg" :class="{ 'is-err': addError }" role="alert">{{ addError || `At least ${MIN_PASSWORD} characters. Share it with the person privately.` }}</p>
      </form>
      <template #footer>
        <button type="button" class="btn btn-secondary" :disabled="addBusy" @click="adding = false">Cancel</button>
        <button type="submit" form="add-account-form" class="btn btn-primary" :disabled="addBusy"><Icon name="plus" />Add account</button>
      </template>
    </Modal>

    <Modal v-if="resetting" :title="`Set a password for ${resetting.name}`" subtitle="Their open sessions end, and they choose a new password at the next sign-in." icon="key" tone="serious" :persistent="resetBusy" @close="resetting = null">
      <form id="reset-password-form" class="form" novalidate @submit.prevent="submitReset">
        <input class="sr" type="text" name="username" autocomplete="off" :value="resetting.name" readonly tabindex="-1" aria-hidden="true">
        <label for="reset-password">Temporary password</label>
        <input id="reset-password" ref="resetPassword" class="input" type="password" autocomplete="new-password" spellcheck="false" maxlength="256" data-autofocus aria-describedby="reset-msg">
        <p id="reset-msg" class="field-msg" :class="{ 'is-err': resetError }" role="alert">{{ resetError || `At least ${MIN_PASSWORD} characters.` }}</p>
      </form>
      <template #footer>
        <button type="button" class="btn btn-secondary" :disabled="resetBusy" @click="resetting = null">Cancel</button>
        <button type="submit" form="reset-password-form" class="btn btn-primary" :disabled="resetBusy"><Icon name="key" />Set password</button>
      </template>
    </Modal>

    <ConfirmDialog
      v-if="deleting"
      :title="`Delete ${deleting.name}?`"
      subtitle="This cannot be undone."
      icon="trash"
      tone="critical"
      confirm-label="Delete account"
      confirm-icon="trash"
      danger
      :busy="deleteBusy"
      :error="deleteError"
      @confirm="confirmDelete"
      @close="deleting = null"
    >
      <ul class="ticks">
        <li>{{ deleting.name }} is signed out everywhere and can no longer sign in.</li>
        <li>Audit events keep the name of the account that made each change.</li>
      </ul>
    </ConfirmDialog>

    <template #locked>
      <div class="wrap">
        <PageHead title="Accounts" />
        <LockNote level="admin" />
      </div>
    </template>
  </ScopeGate>
</template>
