<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import BrandMark from '@/components/BrandMark.vue';
import Icon from '@/components/Icon.vue';
import ThemeSwitch from '@/components/ThemeSwitch.vue';
import { useSession } from '@/context';
import { safeRedirect } from '@/router';

/**
 * Sign in with a dashboard account. The password is read from the field, the field is cleared at once, and it is posted a single
 * time to start a cookie session; it is never held in reactive state, storage, the URL or the router state.
 * After sign-in the visitor returns to `?redirect=` (a same-app path) or to the machines; an account that still has a given
 * password (the first sign-in as `fleet`) is sent to the password page by the router first.
 */
const session = useSession();
const route = useRoute();
const router = useRouter();

const nameInput = ref<HTMLInputElement | null>(null);
const passwordInput = ref<HTMLInputElement | null>(null);
const notice = session.takeNotice();
const message = ref<{ text: string; err: boolean }>({ text: notice?.text ?? '', err: notice?.err ?? false });
const busy = ref(false);

onMounted(async () => {
  await nextTick();
  nameInput.value?.focus();
});

async function submit(): Promise<void> {
  const nameField = nameInput.value;
  const passwordField = passwordInput.value;
  if (!nameField || !passwordField || busy.value) return;
  const name = nameField.value.trim();
  const password = passwordField.value;
  passwordField.value = '';
  if (!name) {
    message.value = { text: 'Enter your account name.', err: true };
    nameField.focus();
    return;
  }
  if (!password) {
    message.value = { text: 'Enter your password.', err: true };
    passwordField.focus();
    return;
  }
  busy.value = true;
  message.value = { text: 'Signing in…', err: false };
  try {
    await session.login(name, password);
    await router.replace(safeRedirect(route.query.redirect) ?? { name: 'machines' });
  } catch (e) {
    busy.value = false;
    message.value = { text: e instanceof Error ? e.message : 'Sign-in failed.', err: true };
    passwordField.focus();
  }
}
</script>

<template>
  <div class="login-wrap">
    <section class="login-card" aria-labelledby="login-title">
      <span class="login-logo"><BrandMark /></span>
      <h1 id="login-title" tabindex="-1">Sign in</h1>
      <p class="login-sub">Use your Fleet account to manage this Fleet Server.</p>
      <form class="form" novalidate @submit.prevent="submit">
        <label for="login-name">Name</label>
        <input id="login-name" ref="nameInput" class="input" type="text" required autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="64">
        <label for="login-password">Password</label>
        <input id="login-password" ref="passwordInput" class="input" type="password" required autocomplete="current-password" spellcheck="false" maxlength="256" aria-describedby="login-msg">
        <p id="login-msg" class="field-msg" :class="{ 'is-err': message.err }" role="alert">{{ message.text }}</p>
        <button class="btn btn-primary" type="submit" :disabled="busy"><Icon name="key" />Sign in</button>
      </form>
      <p class="muted small">The password is sent once to start a session. It is never stored in this browser.</p>
      <div class="login-theme"><ThemeSwitch compact /></div>
    </section>
  </div>
</template>
