<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Avatar from '@/components/Avatar.vue';
import Icon from '@/components/Icon.vue';
import PageHead from '@/components/PageHead.vue';
import StatusGlyph from '@/components/StatusGlyph.vue';
import ThemeSwitch from '@/components/ThemeSwitch.vue';
import { useFleet } from '@/context';
import { safeRedirect } from '@/router';

/**
 * The signed-in account: change the password and pick the theme. API: POST account/password { currentPassword, newPassword }.
 * While the account must change its password (the first sign-in as `fleet`, or after an admin set the password), the router keeps
 * the visitor here; afterwards it continues to `?redirect=` or the machines. Passwords live in the fields only and are cleared on submit.
 */
const { session, toasts } = useFleet();
const route = useRoute();
const router = useRouter();

interface PasswordPolicy {
  min: number;
  max: number;
}
const POLICY: PasswordPolicy = { min: 10, max: 256 };

const forced = computed(() => session.state.mustChangePassword);
const current = ref<HTMLInputElement | null>(null);
const next = ref<HTMLInputElement | null>(null);
const repeat = ref<HTMLInputElement | null>(null);
const message = ref<{ text: string; err: boolean }>({ text: '', err: false });
const busy = ref(false);

function fail(text: string, field: HTMLInputElement | null): void {
  message.value = { text, err: true };
  field?.focus();
}

async function submit(): Promise<void> {
  if (busy.value || !current.value || !next.value || !repeat.value) return;
  const currentPassword = current.value.value;
  const newPassword = next.value.value;
  const repeated = repeat.value.value;
  if (!currentPassword) return fail('Enter your current password.', current.value);
  if (newPassword.length < POLICY.min || newPassword.length > POLICY.max) return fail(`Choose a new password of ${POLICY.min} to ${POLICY.max} characters.`, next.value);
  if (newPassword === currentPassword) return fail('The new password must differ from the current one.', next.value);
  if (newPassword !== repeated) return fail('The two new passwords do not match.', repeat.value);
  current.value.value = next.value.value = repeat.value.value = '';
  busy.value = true;
  message.value = { text: 'Saving…', err: false };
  const wasForced = forced.value;
  try {
    await session.changePassword(currentPassword, newPassword);
    message.value = { text: 'Password changed.', err: false };
    toasts.push('Password changed', { tone: 'good', text: 'Use the new password the next time you sign in.' });
    if (wasForced) await router.replace(safeRedirect(route.query.redirect) ?? { name: 'machines' });
  } catch (e) {
    fail(e instanceof Error ? e.message : 'The password could not be changed.', current.value);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="wrap wrap--narrow">
    <PageHead title="Your account" :sub="forced ? undefined : 'Change your password and choose how the dashboard looks.'" />
    <div v-if="forced" id="password-required" class="callout callout--warning" role="status">
      <StatusGlyph level="warning" kind="bang" />
      <div><b>Choose a new password</b><p>This account still has the password it was given. Replace it to continue.</p></div>
    </div>
    <section class="panel account-panel">
      <header class="panel-head account-who">
        <Avatar :name="session.state.actor" />
        <div><h2>{{ session.state.actor }}</h2><p>Scope: {{ session.scopeLabel() }}</p></div>
      </header>
      <form class="form account-form" novalidate @submit.prevent="submit">
        <!-- The account name helps password managers file the new password under the right entry. -->
        <input class="sr" type="text" name="username" autocomplete="username" :value="session.state.actor ?? ''" readonly tabindex="-1" aria-hidden="true">
        <label for="password-current">Current password</label>
        <input id="password-current" ref="current" class="input" type="password" autocomplete="current-password" spellcheck="false" maxlength="256" required>
        <label for="password-new">New password</label>
        <input id="password-new" ref="next" class="input" type="password" autocomplete="new-password" spellcheck="false" maxlength="256" required aria-describedby="password-hint">
        <p id="password-hint" class="muted small">{{ POLICY.min }} to {{ POLICY.max }} characters. A long passphrase is easier to remember than a short complex password.</p>
        <label for="password-repeat">Repeat the new password</label>
        <input id="password-repeat" ref="repeat" class="input" type="password" autocomplete="new-password" spellcheck="false" maxlength="256" required aria-describedby="password-msg">
        <p id="password-msg" class="field-msg" :class="{ 'is-err': message.err, 'is-ok': !message.err && message.text === 'Password changed.' }" role="alert">{{ message.text }}</p>
        <button class="btn btn-primary" type="submit" :disabled="busy"><Icon name="key" />Change password</button>
      </form>
    </section>
    <section v-if="!forced" class="panel account-panel">
      <header class="panel-head"><h2>Appearance</h2><p>Saved in this browser.</p></header>
      <ThemeSwitch />
    </section>
  </div>
</template>
