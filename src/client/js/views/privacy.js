// #/privacy: what the site stores about a person and what they can do about it. Public: it can be read before signing in.
import { h, mount } from '../dom.js';

export function privacyView({ outlet }) {
  const section = (title, ...body) => h('section', { class: 'card' }, h('h2', {}, title), ...body);
  mount(outlet,
    h('h1', { tabindex: -1 }, 'Privacy'),
    h('p', { class: 'muted' }, 'What this game stores about you, who can see it, and what you can do about it. Whoever runs this site is responsible for it: ask them about anything not covered here.'),
    section('What is stored',
      h('ul', {},
        h('li', {}, h('strong', {}, 'Your email address'), ': to sign you in, and to send turn emails if you turn them on. Nothing else uses it.'),
        h('li', {}, h('strong', {}, 'Your display name'), ': shown to the other players of your games. It need not be your real name.'),
        h('li', {}, h('strong', {}, 'What you do in games'), ': your orders, messages and news, and how each game ended.'),
        h('li', {}, h('strong', {}, 'Sign-in links'), ': for each link we email you, your address and a fingerprint of the link (never the link itself), for about a day.'),
        h('li', {}, h('strong', {}, 'Mail we sent'), ': a small record of which turn emails went out, so none is sent twice.'))),
    section('What other players can see',
      h('p', {}, 'Your display name and your country, and everything that happens in the game. Messages you send go to the player you pick; if you mark one anonymous, they do not see who sent it, but the server still records the sender. Once a game has finished, its players can replay it, including everyone\u2019s orders.')),
    section('On your device',
      h('p', {}, 'No cookies, no tracking and no advertising. Your browser keeps one sign-in token for 30 days, which is removed when you sign out. Like any website, the company that hosts it may log visitors\u2019 network addresses.')),
    section('Email',
      h('p', {}, 'Sign-in links go through the mail service the site\u2019s operator has set up, so your address passes through it. Turn emails are off unless you turn them on from your home page, and each one has a link that stops them.')),
    section('Your choices',
      h('ul', {},
        h('li', {}, 'Change your name, or sign out on every device, on ', h('a', { href: '#/account' }, 'your account page'), '.'),
        h('li', {}, 'Delete your account from the same page. It erases your email address and your turn-email setting, cancels games you were setting up, and puts an AI player in your seat in games still running. Finished games keep their results under the name \u201cDeleted player\u201d. Deleting cannot be undone.'))),
    h('p', {}, h('a', { href: '#/' }, 'Back to the game')));
  return {};
}
