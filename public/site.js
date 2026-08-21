/*
 * One Contractor Solutions — public marketing site behaviour.
 *
 * Three small jobs, and the page works without any of them: the navigation
 * links are real links, the form is a real form, and the videos are real video
 * elements. This file only makes those nicer. Nothing here is load-bearing,
 * which is why none of it is wrapped in error handling that hides failures.
 */
(function () {
  'use strict';

  // -- Mobile navigation ----------------------------------------------------

  var toggle = document.querySelector('.nav-toggle');
  var nav = document.getElementById('site-nav');

  if (toggle && nav) {
    toggle.addEventListener('click', function () {
      var open = nav.classList.toggle('is-open');
      toggle.setAttribute('aria-expanded', String(open));
    });

    // Closing on Escape matters more on a phone than it looks: the open menu
    // covers the page, and without this the only way out is the button.
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && nav.classList.contains('is-open')) {
        nav.classList.remove('is-open');
        toggle.setAttribute('aria-expanded', 'false');
        toggle.focus();
      }
    });
  }

  // -- Video slots ----------------------------------------------------------
  //
  // The clips are not in the repository. Until the files exist, show the
  // designed placeholder instead of a browser's broken-media box.

  Array.prototype.forEach.call(document.querySelectorAll('.clip'), function (fig) {
    var video = fig.querySelector('.clip-video');
    var placeholder = fig.querySelector('.clip-placeholder');
    if (!video || !placeholder) return;

    var fallBack = function () {
      video.hidden = true;
      video.style.display = 'none';
      placeholder.hidden = false;
    };

    video.addEventListener('error', fallBack);
    // `error` does not fire in every browser for a 404 on the source attribute,
    // so also check whether anything was actually loadable once metadata has
    // had a chance to arrive.
    window.setTimeout(function () {
      if (video.networkState === 3 /* NETWORK_NO_SOURCE */ || video.readyState === 0) {
        fallBack();
      }
    }, 2500);
  });

  // -- Demo request form ----------------------------------------------------

  var form = document.getElementById('demo-form');
  if (!form) return;

  var status = document.getElementById('demo-status');
  var submit = document.getElementById('demo-submit');

  var setStatus = function (message, kind) {
    if (!status) return;
    status.textContent = message;
    status.className = 'form-status' + (kind ? ' is-' + kind : '');
  };

  var markInvalid = function (input, message) {
    var field = input.closest('.field');
    if (!field) return;
    field.setAttribute('data-invalid', 'true');
    if (!field.querySelector('.field-error')) {
      var p = document.createElement('p');
      p.className = 'field-error';
      p.textContent = message;
      field.appendChild(p);
    }
  };

  var clearInvalid = function () {
    Array.prototype.forEach.call(form.querySelectorAll('[data-invalid]'), function (f) {
      f.removeAttribute('data-invalid');
      var err = f.querySelector('.field-error');
      if (err) err.remove();
    });
  };

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    clearInvalid();
    setStatus('');

    var data = new FormData(form);
    var value = function (name) { return String(data.get(name) || '').trim(); };

    // Validated here for a fast, friendly message, and again on the server,
    // which is the one that actually decides.
    var required = [
      ['companyName', 'Please tell us your company name.'],
      ['contactName', 'Please tell us your name.'],
      ['email', 'Please give us an email address we can reply to.'],
    ];
    var failed = false;
    required.forEach(function (pair) {
      if (!value(pair[0])) {
        markInvalid(form.elements[pair[0]], pair[1]);
        failed = true;
      }
    });

    var email = value('email');
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      markInvalid(form.elements.email, 'That does not look like an email address.');
      failed = true;
    }

    if (failed) {
      setStatus('Please check the highlighted fields.', 'error');
      var firstBad = form.querySelector('[data-invalid] input');
      if (firstBad) firstBad.focus();
      return;
    }

    var counties = value('counties')
      .split(',')
      .map(function (s) { return s.trim(); })
      .filter(Boolean);

    var payload = {
      companyName: value('companyName'),
      contactName: value('contactName'),
      email: email,
      phone: value('phone') || null,
      trades: data.getAll('trades'),
      counties: counties,
      monthlyPermits: value('monthlyPermits') || null,
      message: value('message') || null,
      sourcePage: window.location.pathname,
      website: value('website'),
    };

    submit.disabled = true;
    var originalLabel = submit.textContent;
    submit.textContent = 'Sending…';
    setStatus('');

    fetch('/api/public/demo-request', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(function (res) {
        return res.json().then(function (body) { return { ok: res.ok, status: res.status, body: body }; });
      })
      .then(function (result) {
        if (result.ok) {
          // Replacing the form rather than clearing it: a form still on screen
          // after a successful send invites a second submission.
          form.innerHTML =
            '<div class="form-done">' +
            '<h2>Thanks — we have got it.</h2>' +
            '<p>We will be in touch shortly to set up a time. ' +
            'If it is urgent, email <a href="mailto:sales@openmarkettraders.com">' +
            'sales@openmarkettraders.com</a>.</p>' +
            '</div>';
          form.scrollIntoView({ block: 'center' });
          return;
        }

        if (result.status === 429) {
          setStatus(
            'That is a few requests in a short time. Give it a minute and try again.',
            'error',
          );
        } else {
          setStatus(
            (result.body && result.body.message) ||
              'Something went wrong sending that. Please email sales@openmarkettraders.com.',
            'error',
          );
        }
        submit.disabled = false;
        submit.textContent = originalLabel;
      })
      .catch(function () {
        setStatus(
          'We could not reach the server. Please email sales@openmarkettraders.com.',
          'error',
        );
        submit.disabled = false;
        submit.textContent = originalLabel;
      });
  });
})();
