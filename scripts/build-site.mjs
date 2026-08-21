/**
 * Builds the public marketing pages into public/.
 *
 * A generator rather than hand-maintained HTML files, for one reason: the
 * navigation, footer and structured data appear on every page, and the moment
 * they are copied they start to drift. "Book a demo" changing on three pages
 * out of four is the kind of thing nobody notices until a prospect does.
 *
 * Everything it emits is a plain static file. Netlify serves them directly and
 * the API serves the same files out of public/, so the marketing site behaves
 * identically on both without a build step in either.
 *
 *   node scripts/build-site.mjs
 */
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Prices come from src/domain/pricing.json, the same file the billing engine
 * reads. A marketing page quoting a number the system does not charge is a
 * promise somebody has to honour, so there is exactly one copy of the table.
 */
const PRICING = JSON.parse(
  await readFile(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'domain', 'pricing.json'),
    'utf8',
  ),
);

const money = (cents) =>
  '$' + (cents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 });

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

/**
 * Canonical origin. Search engines use this to decide which copy of a page is
 * the real one, and the API serves these same files on a second hostname, so
 * leaving it unset would let the two deployments compete with each other for
 * the same rankings.
 *
 * CHANGE THIS when the custom domain goes live.
 */
const SITE_URL = 'https://1contractorapp.netlify.app';

/** Where "Contractor sign in" goes: the React application's own entry point. */
const SIGN_IN = '/dashboard';

const CONTACT_EMAIL = 'sales@openmarkettraders.com';

const NAV = [
  { href: '/how-it-works', label: 'How it works' },
  { href: '/pricing', label: 'Pricing' },
  { href: '/demo', label: 'Book a demo' },
];

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Organisation data, emitted on every page as JSON-LD.
 *
 * Written once here rather than per page: search engines treat conflicting
 * descriptions of the same organisation as a reason to trust none of them.
 */
const ORG_LD = {
  '@context': 'https://schema.org',
  '@type': 'ProfessionalService',
  '@id': `${SITE_URL}/#organization`,
  name: 'One Contractor Solutions',
  description:
    'Florida contractor licensing, qualifier supervision and permit expediting. ' +
    'We hold licenses in every Florida trade, supervise the work on site, and ' +
    'pull permits in all 67 counties.',
  url: SITE_URL,
  email: CONTACT_EMAIL,
  areaServed: { '@type': 'State', name: 'Florida' },
  serviceType: [
    'Contractor licensing',
    'Qualifier supervision',
    'Permit expediting',
    'Permit drafting',
    'Construction compliance',
  ],
};

function layout({ slug, title, description, keywords, body, ld = [], heroClass = '' }) {
  const canonical = SITE_URL + (slug === '/' ? '/' : slug);
  const nav = NAV.map(
    (n) =>
      `<a class="nav-link${n.href === slug ? ' is-current' : ''}" href="${n.href}">${esc(n.label)}</a>`,
  ).join('\n          ');

  const graph = [ORG_LD, ...ld];

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="keywords" content="${esc(keywords)}">
<link rel="canonical" href="${canonical}">
<meta name="robots" content="index, follow, max-image-preview:large">

<meta property="og:site_name" content="One Contractor Solutions">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${canonical}">
<meta property="og:locale" content="en_US">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">

<meta name="theme-color" content="#0f2740">
<link rel="preload" href="/site.css" as="style">
<link rel="stylesheet" href="/site.css">

<script type="application/ld+json">
${JSON.stringify(graph, null, 2)}
</script>
</head>
<body${heroClass ? ` class="${heroClass}"` : ''}>
<a class="skip" href="#main">Skip to content</a>

<header class="site-header">
  <div class="wrap header-inner">
    <a class="brand" href="/" aria-label="One Contractor Solutions, home">
      <span class="brand-mark" aria-hidden="true">1</span>
      <span class="brand-text">One Contractor <em>Solutions</em></span>
    </a>

    <button class="nav-toggle" type="button" aria-expanded="false" aria-controls="site-nav">
      <span class="sr-only">Menu</span>
      <span class="bars" aria-hidden="true"></span>
    </button>

    <nav class="site-nav" id="site-nav" aria-label="Main">
      <div class="nav-links">
          ${nav}
      </div>
      <div class="nav-actions">
        <a class="btn btn-ghost" href="${SIGN_IN}">Contractor sign in</a>
        <a class="btn btn-primary" href="/demo">Book a demo</a>
      </div>
    </nav>
  </div>
</header>

<main id="main">
${body}
</main>

<footer class="site-footer">
  <div class="wrap footer-grid">
    <div class="footer-brand">
      <div class="brand brand-footer">
        <span class="brand-mark" aria-hidden="true">1</span>
        <span class="brand-text">One Contractor <em>Solutions</em></span>
      </div>
      <p class="footer-blurb">
        Florida licensing, supervision and permitting — done the right way,
        under our licenses and with our supervisors on your site.
      </p>
      <p class="footer-blurb"><a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a></p>
    </div>
    <div>
      <h3>Company</h3>
      <a href="/">Home</a>
      <a href="/how-it-works">How it works</a>
      <a href="/pricing">Pricing</a>
      <a href="/demo">Book a demo</a>
    </div>
    <div>
      <h3>Services</h3>
      <a href="/how-it-works#licensing">Licensing &amp; qualifying</a>
      <a href="/how-it-works#supervision">On-site supervision</a>
      <a href="/how-it-works#permitting">Permit expediting</a>
      <a href="/how-it-works#trades">Trades we cover</a>
    </div>
    <div>
      <h3>Contractors</h3>
      <a href="${SIGN_IN}">Sign in</a>
      <a href="/demo">Request access</a>
      <p class="footer-fine">Serving all 67 Florida counties.</p>
    </div>
  </div>
  <div class="wrap footer-legal">
    <p>&copy; ${new Date().getFullYear()} One Contractor Solutions. All rights reserved.</p>
    <p>
      Work performed under our licenses is supervised by our qualifiers in
      accordance with Chapter 489, Florida Statutes, and the rules of the
      Florida Department of Business and Professional Regulation.
    </p>
  </div>
</footer>

<script src="/site.js" defer></script>
</body>
</html>
`;
}

/**
 * A video slot.
 *
 * The clips are not in the repository -- they are marketing media, and binary
 * files in git are a mistake that compounds. The slot renders a designed
 * placeholder until a file exists at the path, and site.js swaps to it if the
 * video fails to load, so a missing clip is never a broken black box.
 */
function clip({ src, poster, title, caption }) {
  return `
        <figure class="clip">
          <div class="clip-frame">
            <video class="clip-video" src="${src}"${poster ? ` poster="${poster}"` : ''}
                   controls playsinline preload="metadata" aria-label="${esc(title)}"></video>
            <div class="clip-placeholder" hidden>
              <span class="clip-play" aria-hidden="true"></span>
              <p class="clip-placeholder-title">${esc(title)}</p>
              <p class="clip-placeholder-note">Video coming soon</p>
            </div>
          </div>
          <figcaption>${esc(caption)}</figcaption>
        </figure>`;
}

/**
 * Frequently asked questions.
 *
 * These earn their place twice: they answer the objections that actually come
 * up on sales calls, and they are the questions people type into a search
 * engine word for word. Emitted as FAQPage structured data as well as visible
 * text, because a question answered in the results page still reaches the
 * person asking it.
 */
const FAQS = [
  {
    q: 'Can I pull a permit in Florida without a license?',
    a:
      'Not on your own. The permit has to be pulled by a licensed contractor who ' +
      'qualifies the work. What we do is qualify it under our license and supervise ' +
      'it properly, so the job goes ahead lawfully instead of not going ahead at all.',
  },
  {
    q: 'Is this the same as renting a license?',
    a:
      'No, and the difference matters. Under Chapter 489 a qualifier must actually ' +
      'supervise the work their license goes on. We assign a named supervisor before ' +
      'anything is filed, they attend the site, and the check-ins and photographs are ' +
      'kept against the permit. Renting a license means nobody supervises anything; ' +
      'that is an offence, and it is not what we do.',
  },
  {
    q: 'Which Florida counties do you work in?',
    a:
      'All 67. That includes the high-velocity hurricane zone jurisdictions of ' +
      'Miami-Dade and Broward, where product approvals and Notices of Acceptance ' +
      'apply, and coastal flood zones where substantial-improvement rules come into play.',
  },
  {
    q: 'Which trades are you licensed for?',
    a:
      'Every trade licensed in Florida — roofing, plumbing, electrical, HVAC and ' +
      'mechanical, general and building, pool, solar, sheet metal, underground utilities ' +
      'and the specialty categories. If your job needs a license you do not hold, ask us.',
  },
  {
    q: 'How long does a permit take?',
    a:
      'That depends on the jurisdiction and how clean the submission is. The part we ' +
      'control is the second one: most delay comes from correction cycles, so the ' +
      'platform tracks what each jurisdiction has rejected before and applies it to ' +
      'the next filing.',
  },
  {
    q: 'What does it cost?',
    a:
      'Pricing depends on the trade, the counties you work in and how many permits you ' +
      'run a month. Book a demo and you will get a straight number for your situation ' +
      'on the call.',
  },
  {
    q: 'Do I get to see what is happening with my permits?',
    a:
      'Yes. You get your own sign-in to the same platform our permit techs use. Every ' +
      'permit, correction cycle, inspection result and supervision photograph is there ' +
      'as it happens, not summarised in an email later.',
  },
];

function faqSection() {
  const items = FAQS.map(
    (f) => `
        <details class="faq-item">
          <summary><h3>${esc(f.q)}</h3></summary>
          <p>${esc(f.a)}</p>
        </details>`,
  ).join('');

  return `
  <section class="section" id="faq" aria-labelledby="faq-title">
    <div class="wrap wrap-narrow">
      <div class="section-head">
        <h2 id="faq-title">Questions contractors ask us</h2>
        <p>The ones that come up on nearly every call.</p>
      </div>
      <div class="faq">${items}
      </div>
    </div>
  </section>`;
}

const FAQ_LD = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: FAQS.map((f) => ({
    '@type': 'Question',
    name: f.q,
    acceptedAnswer: { '@type': 'Answer', text: f.a },
  })),
};

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------

const home = layout({
  slug: '/',
  heroClass: 'has-hero',
  title: 'Florida Contractor Licensing, Supervision & Permitting | One Contractor Solutions',
  description:
    'We hold licenses in every Florida trade, supervise the work on site, and pull ' +
    'permits in all 67 counties. One stop for contractors who want it done the right way.',
  keywords:
    'Florida contractor licensing, permit expediting Florida, qualifier supervision, ' +
    'pull a permit without a license Florida, DBPR compliance, Miami-Dade permits, ' +
    'Broward permits, roofing permit Florida, construction permitting platform',
  ld: [FAQ_LD],
  body: `
  <section class="hero">
    <div class="wrap hero-inner">
      <p class="eyebrow">Licensed · Supervised · Permitted</p>
      <h1>
        The license, the supervision, and the permit —
        <span class="hl">all from one place.</span>
      </h1>
      <p class="lede">
        We hold licenses in every trade in Florida. You do the work, we qualify it,
        and our own supervisors are on your site to oversee it. Every permit gets
        pulled, tracked and closed out on a platform you can see straight into.
      </p>
      <div class="hero-actions">
        <a class="btn btn-primary btn-lg" href="/demo">Book a demo</a>
        <a class="btn btn-outline btn-lg" href="${SIGN_IN}">Contractor sign in</a>
      </div>
      <p class="hero-note">
        All 67 Florida counties · Every DBPR rule followed, every time
      </p>
    </div>
  </section>

  <section class="band" aria-label="At a glance">
    <div class="wrap band-inner">
      <div class="stat"><b>67</b><span>Florida counties served</span></div>
      <div class="stat"><b>Every</b><span>licensed trade in the state</span></div>
      <div class="stat"><b>100%</b><span>of jobs supervised on site</span></div>
      <div class="stat"><b>One</b><span>platform for the whole job</span></div>
    </div>
  </section>

  <section class="section" aria-labelledby="what-title">
    <div class="wrap">
      <div class="section-head">
        <h2 id="what-title">A one stop shop for doing it the right way</h2>
        <p>
          Contractors lose work for one of two reasons: they do not hold the license
          the job calls for, or the permit is sitting somewhere nobody is watching.
          We solve both — and we do it inside the law, not around it.
        </p>
      </div>

      <div class="cards">
        <article class="card">
          <span class="card-icon" aria-hidden="true">◆</span>
          <h3>We hold the licenses</h3>
          <p>
            Every trade in Florida. If your job needs a license you do not have, it
            goes out under ours — properly qualified, never rented.
          </p>
        </article>
        <article class="card">
          <span class="card-icon" aria-hidden="true">◆</span>
          <h3>We supervise the work</h3>
          <p>
            Our supervisors are on your site. They check in on location, photograph
            the work as it goes in, and the record is kept — because supervision you
            cannot prove is not supervision.
          </p>
        </article>
        <article class="card">
          <span class="card-icon" aria-hidden="true">◆</span>
          <h3>We pull the permits</h3>
          <p>
            Application through closeout, in every jurisdiction. Corrections,
            inspections and expirations are tracked for you instead of being
            discovered late.
          </p>
        </article>
        <article class="card">
          <span class="card-icon" aria-hidden="true">◆</span>
          <h3>We follow every DBPR rule</h3>
          <p>
            Chapter 489 is not a formality here. Our qualifiers genuinely supervise
            the work their license goes on, and the platform exists to keep that
            provable.
          </p>
        </article>
      </div>
    </div>
  </section>

  <section class="section section-alt" aria-labelledby="clips-title">
    <div class="wrap">
      <div class="section-head">
        <h2 id="clips-title">See how it works</h2>
        <p>A look at how we run a job, and at the platform your team would use.</p>
      </div>
      <div class="clips">
${clip({
  src: '/media/how-we-work.mp4',
  poster: '/media/how-we-work.jpg',
  title: 'How we work',
  caption: 'Licensing, supervision and site oversight, start to finish.',
})}
${clip({
  src: '/media/platform-tour.mp4',
  poster: '/media/platform-tour.jpg',
  title: 'Platform tour',
  caption: 'Every permit, correction and inspection on one screen.',
})}
      </div>
    </div>
  </section>

  <section class="section" aria-labelledby="platform-title">
    <div class="wrap split">
      <div class="split-text">
        <p class="eyebrow">The platform</p>
        <h2 id="platform-title">This is our permitting platform</h2>
        <p>
          It is the same system our permit techs work in every day, and you get your
          own view of it. Not a status email once a week — the actual record, as it
          changes.
        </p>
        <ul class="ticks">
          <li>Every permit, with where it truly stands right now</li>
          <li>Corrections logged with the cycle count, so nothing quietly repeats</li>
          <li>Inspections scheduled, results recorded, re-inspections booked automatically</li>
          <li>Supervision photographs and site check-ins attached to the job they belong to</li>
          <li>Documents, drafting and notary in the same place as the permit</li>
        </ul>
        <a class="btn btn-primary" href="/demo">Book a demo</a>
      </div>
      <div class="split-visual" aria-hidden="true">
        <div class="mock">
          <div class="mock-bar"><span></span><span></span><span></span></div>
          <div class="mock-row"><b>Re-roof · Broward</b><i class="pill pill-amber">Corrections · cycle 2</i></div>
          <div class="mock-row"><b>Plumbing · Hillsborough</b><i class="pill pill-green">Issued</i></div>
          <div class="mock-row"><b>Electrical · Miami-Dade</b><i class="pill pill-blue">Inspection Thu</i></div>
          <div class="mock-row"><b>HVAC · Orange</b><i class="pill pill-grey">In review</i></div>
          <div class="mock-foot">Supervisor checked in · 4 photos · 9:12 AM</div>
        </div>
      </div>
    </div>
  </section>

  <section class="section section-alt" aria-labelledby="coverage-title">
    <div class="wrap wrap-narrow center">
      <div class="section-head">
        <h2 id="coverage-title">Working anywhere in Florida</h2>
        <p>
          From the high-velocity hurricane zone in Miami-Dade and Broward to the
          Panhandle, we file where the work is.
        </p>
      </div>
      <p class="county-list">
        Miami-Dade · Broward · Palm Beach · Hillsborough · Pinellas · Orange ·
        Duval · Lee · Collier · Sarasota · Manatee · Polk · Brevard · Volusia ·
        St. Lucie · Martin · Charlotte · Pasco · Seminole · Osceola · Alachua ·
        Leon · Escambia · Bay · <strong>and every other Florida county</strong>
      </p>
    </div>
  </section>

  <section class="section" aria-labelledby="pricing-teaser-title">
    <div class="wrap wrap-narrow center">
      <div class="section-head">
        <h2 id="pricing-teaser-title">Straightforward pricing</h2>
        <p>
          Priced by the trade you work in, the counties you file in and how many
          permits you run a month — with no surprises added at closeout.
        </p>
      </div>
      <a class="btn btn-outline btn-lg" href="/pricing">See pricing</a>
    </div>
  </section>

${faqSection()}

  <section class="cta">
    <div class="wrap cta-inner">
      <h2>Ready to see it?</h2>
      <p>Twenty minutes, your jobs, your counties. We will show you exactly how it would run.</p>
      <div class="hero-actions">
        <a class="btn btn-primary btn-lg" href="/demo">Book a demo</a>
        <a class="btn btn-outline btn-lg" href="${SIGN_IN}">Contractor sign in</a>
      </div>
    </div>
  </section>
`,
});

// ---------------------------------------------------------------------------
// How it works
// ---------------------------------------------------------------------------

const howItWorks = layout({
  slug: '/how-it-works',
  title: 'How It Works — Licensing, Supervision & Permit Expediting in Florida',
  description:
    'How our Florida licensing, qualifier supervision and permit expediting service ' +
    'works, and how we keep it compliant with Chapter 489 and DBPR rules.',
  keywords:
    'qualifier supervision Florida, Chapter 489 supervision, contractor license qualifier, ' +
    'permit expediting process, DBPR rules, Florida trades licensed',
  body: `
  <section class="page-head">
    <div class="wrap wrap-narrow">
      <p class="eyebrow">How it works</p>
      <h1>Four steps — and we handle three of them.</h1>
      <p class="lede">
        You bring the job. We bring the license, the supervisor and the permit.
      </p>
    </div>
  </section>

  <section class="section" id="licensing" aria-labelledby="steps-title">
    <div class="wrap">
      <h2 class="sr-only" id="steps-title">The four steps</h2>
      <ol class="steps">
        <li>
          <span class="step-n">1</span>
          <div>
            <h3>Tell us about the job</h3>
            <p>
              Scope, address, valuation, trade. A few minutes on the intake form, or
              your permit tech fills it in with you over the phone.
            </p>
          </div>
        </li>
        <li>
          <span class="step-n">2</span>
          <div>
            <h3>We qualify it under our license</h3>
            <p>
              We confirm the trade is one we are licensed for, that the license is
              current, and that a supervisor is assigned — before anything is filed.
              If any of those is not true, nothing goes out. That is the whole point.
            </p>
          </div>
        </li>
        <li>
          <span class="step-n">3</span>
          <div>
            <h3>Our supervisor oversees the work</h3>
            <p>
              On site, checked in by location, photographing the work as it goes in.
              The photographs and check-ins attach to the permit, so the supervision
              record is built while the job runs rather than reconstructed afterwards.
            </p>
          </div>
        </li>
        <li>
          <span class="step-n">4</span>
          <div>
            <h3>We take the permit to closeout</h3>
            <p>
              Filing, corrections, inspections, re-inspections and final closeout. You
              watch it happen on your own dashboard instead of asking where it stands.
            </p>
          </div>
        </li>
      </ol>
    </div>
  </section>

  <section class="section section-alt" id="supervision" aria-labelledby="supervision-title">
    <div class="wrap">
      <div class="section-head">
        <h2 id="supervision-title">Why our supervision is real</h2>
        <p>
          In Florida, a qualifier who lets their license be used on work they do not
          actually supervise is committing an offence. The difference between a
          legitimate service and renting a license is whether the supervision truly
          happened and can be shown. We built the platform around proving it.
        </p>
      </div>
      <div class="cards">
        <article class="card">
          <h3>A named supervisor, before filing</h3>
          <p>
            Work cannot be qualified under our license until a specific, accountable
            person is assigned to it.
          </p>
        </article>
        <article class="card">
          <h3>Current licenses only</h3>
          <p>
            An expired license, or one that does not cover the trade, is refused
            outright rather than flagged for someone to notice later.
          </p>
        </article>
        <article class="card">
          <h3>Site check-ins with location</h3>
          <p>
            Supervisors check in where the work is. A check-in far from the site stays
            visible instead of being quietly dropped.
          </p>
        </article>
        <article class="card">
          <h3>Photographs, kept</h3>
          <p>
            A visit is not complete without photographic evidence of the work. The
            record is what makes the supervision defensible.
          </p>
        </article>
      </div>
    </div>
  </section>

  <section class="section" id="permitting" aria-labelledby="permitting-title">
    <div class="wrap split">
      <div class="split-text">
        <p class="eyebrow">Permitting</p>
        <h2 id="permitting-title">The requirements that catch people out</h2>
        <p>
          High-velocity hurricane zone product approvals in Miami-Dade and Broward.
          Notices of Commencement over the statutory threshold. Substantial-improvement
          rules in flood zones. Jurisdiction quirks that are written down nowhere.
        </p>
        <p>
          Every correction a jurisdiction sends us becomes a checklist item for the
          next filing there — including filings for other contractors. One company's
          painful rejection turns into everyone's advantage.
        </p>
        <a class="btn btn-primary" href="/demo">Talk to us about your jurisdiction</a>
      </div>
      <div class="split-visual" aria-hidden="true">
        <div class="mock">
          <div class="mock-bar"><span></span><span></span><span></span></div>
          <div class="mock-row"><b>Broward · re-roof</b><i class="pill pill-amber">Roof-deck photo required</i></div>
          <div class="mock-row"><b>Miami-Dade · windows</b><i class="pill pill-blue">NOA number required</i></div>
          <div class="mock-row"><b>Any · over $2,500</b><i class="pill pill-green">NOC recorded</i></div>
          <div class="mock-foot">Learned from 3 correction cycles</div>
        </div>
      </div>
    </div>
  </section>

  <section class="section section-alt" id="trades" aria-labelledby="trades-title">
    <div class="wrap wrap-narrow center">
      <div class="section-head">
        <h2 id="trades-title">If it needs a license in Florida, we hold it</h2>
        <p>And the jurisdiction-specific requirements that come with each one.</p>
      </div>
      <div class="trade-grid">
        <span>Roofing</span><span>Plumbing</span><span>Electrical</span>
        <span>HVAC</span><span>General</span><span>Building</span>
        <span>Mechanical</span><span>Pool</span><span>Solar</span>
        <span>Specialty</span><span>Sheet metal</span><span>Underground</span>
      </div>
    </div>
  </section>

  <section class="cta">
    <div class="wrap cta-inner">
      <h2>Let us show you on one of your jobs</h2>
      <p>Bring a real permit you are chasing. We will walk it through the platform with you.</p>
      <div class="hero-actions">
        <a class="btn btn-primary btn-lg" href="/demo">Book a demo</a>
      </div>
    </div>
  </section>
`,
});

// ---------------------------------------------------------------------------
// Pricing
//
// Figures come from src/domain/pricing.json. Every charge is shown as its own
// line rather than rolled into one number, because that is how they are billed
// and a prospect who discovers a second charge later stops trusting the first.
// ---------------------------------------------------------------------------

const planByKey = Object.fromEntries(PRICING.plans.map((p) => [p.key, p]));
const ownLicense = planByKey.OWN_LICENSE;
const allTrades = planByKey.ALL_TRADES;
const tradeTiers = PRICING.plans.filter(
  (p) => p.kind === 'white_glove' && p.key !== 'ALL_TRADES',
);

const pricing = layout({
  slug: '/pricing',
  title: 'Pricing — Florida Permitting, Licensing & Supervision | One Contractor Solutions',
  description:
    `Bring your own license at ${money(ownLicense.pricePerPermitCents)} per permit, or go White Glove ` +
    'from $1,500 a month with our license, our qualifier and our supervisors on your site.',
  keywords:
    'Florida permit expediting cost, contractor licensing pricing, qualifier supervision cost, ' +
    'white glove permitting Florida, permit service pricing',
  ld: [FAQ_LD],
  body: `
  <section class="page-head">
    <div class="wrap wrap-narrow">
      <p class="eyebrow">Pricing</p>
      <h1>Two ways to work with us.</h1>
      <p class="lede">
        Already licensed? Pay per permit. Need the license, the qualifier and the
        supervision? That is White Glove, priced by how many trade classifications
        you need.
      </p>
    </div>
  </section>

  <section class="section" aria-labelledby="own-title">
    <div class="wrap">
      <div class="two-up">
        <article class="plan">
          <h2 id="own-title">${esc(ownLicense.name)}</h2>
          <p class="plan-price">
            <b>${money(ownLicense.pricePerPermitCents)}</b> <span>per permit</span>
          </p>
          <p class="plan-blurb">
            You hold the license. We do the permitting: filing, corrections,
            inspections and closeout, on the same platform our permit techs use.
          </p>
          <ul class="ticks">
            <li>No monthly fee</li>
            <li>No onboarding fee</li>
            <li>No compliance retainer</li>
            <li>Your own sign-in to track every permit</li>
          </ul>
          <a class="btn btn-outline btn-block" href="/demo">Book a demo</a>
        </article>

        <article class="plan plan-featured">
          <span class="plan-flag">Our full service</span>
          <h2>White Glove</h2>
          <p class="plan-price">
            <b>From ${money(tradeTiers[0].monthlyPriceCents)}</b> <span>a month</span>
          </p>
          <p class="plan-blurb">
            Our license, our qualifier and our own supervisors on your site — so you
            can take work you are not licensed for, lawfully.
          </p>
          <ul class="ticks">
            <li>Work qualified under our Florida license</li>
            <li>A named supervisor assigned before anything is filed</li>
            <li>On-site check-ins and a photographic record</li>
            <li>Unlimited permits within your agreed volume</li>
            <li>Drafting, notary and document signing included</li>
          </ul>
          <a class="btn btn-primary btn-block" href="#tiers">See the tiers</a>
        </article>
      </div>
    </div>
  </section>

  <section class="section section-alt" id="tiers" aria-labelledby="tiers-title">
    <div class="wrap">
      <div class="section-head">
        <h2 id="tiers-title">White Glove, by trade classification</h2>
        <p>
          Priced by how many classifications you need to work under. Every charge is
          listed separately — there is nothing rolled up out of sight.
        </p>
      </div>

      <div class="table-scroll">
        <table class="price-table">
          <caption class="sr-only">White Glove pricing by number of trade classifications</caption>
          <thead>
            <tr>
              <th scope="col">Classifications</th>
              <th scope="col">Monthly service</th>
              <th scope="col">Onboarding <span>one-time</span></th>
              <th scope="col">Compliance retainer <span>held on account</span></th>
            </tr>
          </thead>
          <tbody>
${tradeTiers
  .map(
    (p) => `            <tr>
              <th scope="row">${p.tradeCount} ${p.tradeCount === 1 ? 'trade' : 'trades'}</th>
              <td><b>${money(p.monthlyPriceCents)}</b><span>/mo</span></td>
              <td>${money(p.onboardingFeeCents)}</td>
              <td>${money(p.complianceRetainerCents)}</td>
            </tr>`,
  )
  .join('\n')}
            <tr class="is-featured">
              <th scope="row">
                ${esc(allTrades.name)}
                <span>${PRICING.allTradesThreshold}+ classifications</span>
              </th>
              <td><b>${money(allTrades.monthlyPriceCents)}</b><span>/mo</span></td>
              <td>${money(allTrades.onboardingFeeCents)}</td>
              <td>${money(allTrades.complianceRetainerCents)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <p class="pricing-note">
        Need ${PRICING.allTradesThreshold} or more classifications? That is the
        One-Stop All Trades plan — it costs less than stacking individual trades and
        covers everything we are licensed for.
      </p>
    </div>
  </section>

  <section class="section" aria-labelledby="charges-title">
    <div class="wrap">
      <div class="section-head">
        <h2 id="charges-title">What appears on your invoice</h2>
        <p>
          Five separate lines, always. You should never have to work out what a number
          is made of.
        </p>
      </div>

      <div class="cards">
        <article class="card">
          <h3>Monthly service fee</h3>
          <p>Your White Glove tier. Billed monthly, and nothing else is hidden inside it.</p>
        </article>
        <article class="card">
          <h3>Onboarding fee</h3>
          <p>
            Charged once, when you first activate a White Glove plan. Move up a tier
            later and you pay only the difference — never the whole fee twice.
          </p>
        </article>
        <article class="card">
          <h3>Compliance retainer</h3>
          <p>
            Held on account against the licensing risk we carry for you. Kept on its
            own ledger, separate from what you pay us for the service.
          </p>
        </article>
        <article class="card">
          <h3>Government fees</h3>
          <p>
            What the county or city charges, passed through at cost. We tell you the
            number before we file.
          </p>
        </article>
        <article class="card">
          <h3>Supervisor visits</h3>
          <p>
            <b>${money(PRICING.supervisorVisitCents)}</b> per completed visit, per active
            job site. Charged when the visit is done and the record is filed — not before.
          </p>
        </article>
        <article class="card">
          <h3>Nothing else</h3>
          <p>
            No per-correction charges, no per-inspection charges, no fee for asking us
            a question.
          </p>
        </article>
      </div>
    </div>
  </section>

  <section class="section section-alt" aria-labelledby="changes-title">
    <div class="wrap wrap-narrow">
      <div class="section-head">
        <h2 id="changes-title">Moving between tiers</h2>
        <p>Businesses change. The pricing should not punish that.</p>
      </div>
      <ul class="ticks">
        <li>
          <b>Adding trades:</b> you pay only the difference between the onboarding fee
          you already paid and the one for your new tier.
        </li>
        <li>
          <b>Your retainer moves with you:</b> upgrading raises it to the new tier's
          level, because the licensing risk we carry has gone up.
        </li>
        <li>
          <b>Dropping trades:</b> your monthly fee falls straight away. Onboarding fees
          already paid are not refunded, and any reduction in your retainer is reviewed
          by us first.
        </li>
        <li>
          <b>Your price is locked to your agreement:</b> we record the exact figures on
          the day you sign, so a later change to our published pricing does not move
          what you are charged.
        </li>
      </ul>
      <a class="btn btn-primary" href="/demo">Talk through your tier</a>
    </div>
  </section>

${faqSection()}

  <section class="cta">
    <div class="wrap cta-inner">
      <h2>Not sure which tier you need?</h2>
      <p>Tell us the trades and the counties. We will tell you straight, on the call.</p>
      <div class="hero-actions">
        <a class="btn btn-primary btn-lg" href="/demo">Book a demo</a>
      </div>
    </div>
  </section>
`,
});

// ---------------------------------------------------------------------------
// Book a demo
// ---------------------------------------------------------------------------

const TRADES = [
  'Roofing', 'Plumbing', 'Electrical', 'HVAC', 'General / Building',
  'Mechanical', 'Pool', 'Solar', 'Specialty',
];

const demo = layout({
  slug: '/demo',
  title: 'Book a Demo — One Contractor Solutions',
  description:
    'Book a twenty-minute walkthrough of our Florida licensing, supervision and ' +
    'permitting service, using one of your own jobs.',
  keywords:
    'book a demo permitting software, Florida contractor licensing demo, permit expediting demo',
  body: `
  <section class="page-head">
    <div class="wrap wrap-narrow">
      <p class="eyebrow">Book a demo</p>
      <h1>Twenty minutes, on one of your jobs.</h1>
      <p class="lede">
        Tell us what you build and where. We will show you how the licensing, the
        supervision and the permit would actually run.
      </p>
    </div>
  </section>

  <section class="section">
    <div class="wrap form-layout">
      <form class="demo-form" id="demo-form" novalidate>
        <div class="field">
          <label for="companyName">Company name <span class="req">*</span></label>
          <input id="companyName" name="companyName" type="text" required maxlength="200"
                 autocomplete="organization">
        </div>

        <div class="field-row">
          <div class="field">
            <label for="contactName">Your name <span class="req">*</span></label>
            <input id="contactName" name="contactName" type="text" required maxlength="200"
                   autocomplete="name">
          </div>
          <div class="field">
            <label for="phone">Phone</label>
            <input id="phone" name="phone" type="tel" maxlength="40" autocomplete="tel">
          </div>
        </div>

        <div class="field">
          <label for="email">Email <span class="req">*</span></label>
          <input id="email" name="email" type="email" required maxlength="320" autocomplete="email">
        </div>

        <fieldset class="field">
          <legend>Which trades do you work in?</legend>
          <div class="chips">
${TRADES.map(
  (t) =>
    `            <label class="chip"><input type="checkbox" name="trades" value="${esc(t)}"><span>${esc(t)}</span></label>`,
).join('\n')}
          </div>
        </fieldset>

        <div class="field-row">
          <div class="field">
            <label for="counties">Counties you work in</label>
            <input id="counties" name="counties" type="text" maxlength="300"
                   placeholder="Broward, Miami-Dade, Palm Beach">
            <p class="hint">Separate with commas.</p>
          </div>
          <div class="field">
            <label for="monthlyPermits">Permits a month</label>
            <select id="monthlyPermits" name="monthlyPermits">
              <option value="">Select…</option>
              <option>1–5</option>
              <option>6–20</option>
              <option>21–50</option>
              <option>50+</option>
            </select>
          </div>
        </div>

        <div class="field">
          <label for="message">Anything you want us to look at?</label>
          <textarea id="message" name="message" rows="4" maxlength="4000"
                    placeholder="A permit that is stuck, a trade you are not licensed for, a job you had to turn down…"></textarea>
        </div>

        <!-- Not visible to people. Anything typed here came from a bot. -->
        <div class="hp" aria-hidden="true">
          <label for="website">Website</label>
          <input id="website" name="website" type="text" tabindex="-1" autocomplete="off">
        </div>

        <button class="btn btn-primary btn-lg btn-block" type="submit" id="demo-submit">
          Book my demo
        </button>

        <p class="form-status" id="demo-status" role="status" aria-live="polite"></p>
        <p class="form-fine">
          We use this to prepare for the call and to get back to you. Nothing else.
        </p>
      </form>

      <aside class="form-aside">
        <h2>What to expect</h2>
        <ul class="ticks">
          <li>A real walkthrough, not a slide deck</li>
          <li>Bring a permit you are chasing — we will look at it</li>
          <li>A straight answer on whether we are licensed for your trade</li>
          <li>About twenty minutes</li>
        </ul>

        <div class="aside-box">
          <h3>Already a client?</h3>
          <p>Your dashboard is where every permit, correction and inspection lives.</p>
          <a class="btn btn-outline" href="${SIGN_IN}">Contractor sign in</a>
        </div>

        <div class="aside-box">
          <h3>Prefer email?</h3>
          <p><a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a></p>
        </div>
      </aside>
    </div>
  </section>
`,
});

// ---------------------------------------------------------------------------

const PAGES = [
  ['index.html', home, '/'],
  ['how-it-works.html', howItWorks, '/how-it-works'],
  ['pricing.html', pricing, '/pricing'],
  ['demo.html', demo, '/demo'],
];

const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemap.org/schemas/sitemap/0.9">
${PAGES.map(
  ([, , path]) => `  <url>
    <loc>${SITE_URL}${path === '/' ? '/' : path}</loc>
    <changefreq>weekly</changefreq>
    <priority>${path === '/' ? '1.0' : '0.8'}</priority>
  </url>`,
).join('\n')}
</urlset>
`.replace('www.sitemap.org', 'www.sitemaps.org');

const robots = `User-agent: *
Allow: /

# The application itself is behind a sign-in and has nothing to index.
Disallow: /dashboard
Disallow: /permits
Disallow: /clients
Disallow: /settings
Disallow: /api/

Sitemap: ${SITE_URL}/sitemap.xml
`;

await mkdir(PUBLIC_DIR, { recursive: true });
for (const [name, html] of PAGES) {
  await writeFile(join(PUBLIC_DIR, name), html, 'utf8');
  console.log('wrote public/' + name);
}
await writeFile(join(PUBLIC_DIR, 'sitemap.xml'), sitemap, 'utf8');
await writeFile(join(PUBLIC_DIR, 'robots.txt'), robots, 'utf8');
console.log('wrote public/sitemap.xml, public/robots.txt');
