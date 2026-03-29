---
name: frontend-design
description: |
  Create distinctive, production-grade frontend interfaces with high design quality.
  Use when: building web components, pages, dashboards, landing pages, React components,
  HTML/CSS layouts, or when styling/beautifying any web UI.
  Triggers: design, UI, component, layout, landing page, dashboard, animation, styling,
  Tailwind, CSS, beautiful, make it look good, frontend, visual, dark mode, theme.
license: Complete terms in LICENSE.txt
---

# Frontend Design

Creates distinctive, production-grade interfaces. Avoids generic "AI slop" aesthetics — every design has a clear point-of-view.

## Before Writing Code

Answer these four questions first:

1. **Purpose** — What problem does this solve? Who uses it?
2. **Tone** — Pick one and commit: brutally minimal / maximalist / retro-futuristic / editorial / brutalist / art deco / soft & organic / industrial / luxury / playful
3. **Memorable hook** — What's the ONE thing the user remembers about this UI?
4. **Constraints** — Framework, performance needs, accessibility level

**Rule:** Bold minimalism and elaborate maximalism both work. The sin is being timid and generic.

## Typography

- Pick fonts that have **character** — pair a display font with a body font
- NEVER: Inter, Roboto, Arial, system-ui as primary fonts
- Sources: Google Fonts, Bunny Fonts, Adobe Fonts
- Establish a type scale: `--text-xs` through `--text-display`

```css
/* Example: Editorial pairing */
@import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;700;900&family=DM+Sans:wght@300;400;500&display=swap');

:root {
  --font-display: 'Playfair Display', serif;
  --font-body: 'DM Sans', sans-serif;
  --text-xs: clamp(0.75rem, 1vw, 0.875rem);
  --text-sm: clamp(0.875rem, 1.5vw, 1rem);
  --text-base: clamp(1rem, 2vw, 1.125rem);
  --text-lg: clamp(1.25rem, 3vw, 1.5rem);
  --text-xl: clamp(1.5rem, 4vw, 2rem);
  --text-display: clamp(2.5rem, 8vw, 6rem);
}
```

## Color & Theme

- One dominant hue + one sharp accent + neutrals
- Use CSS custom properties for everything — no hardcoded colors in components
- Dominant colors with sharp accents beat evenly-distributed palettes

```css
:root {
  /* Example: Industrial dark */
  --bg-base: #0a0a0a;
  --bg-surface: #141414;
  --bg-elevated: #1e1e1e;
  --accent: #e8ff00;          /* single punchy accent */
  --accent-dim: #b8cc00;
  --text-primary: #f0f0f0;
  --text-secondary: #888;
  --text-muted: #444;
  --border: rgba(255,255,255,0.08);
}
```

## Motion

- CSS-only for HTML artifacts; Motion library for React
- One well-orchestrated page load (staggered reveals) > scattered micro-interactions
- Hover states that surprise

```css
/* Staggered reveal on load */
@keyframes fadeUp {
  from { opacity: 0; transform: translateY(20px); }
  to   { opacity: 1; transform: translateY(0); }
}

.card { animation: fadeUp 0.5s ease both; }
.card:nth-child(1) { animation-delay: 0.1s; }
.card:nth-child(2) { animation-delay: 0.2s; }
.card:nth-child(3) { animation-delay: 0.3s; }
```

```tsx
// React with Motion
import { motion } from 'motion/react';

<motion.div
  initial={{ opacity: 0, y: 20 }}
  animate={{ opacity: 1, y: 0 }}
  transition={{ duration: 0.4, ease: [0.25, 0.1, 0.25, 1] }}
>
  {children}
</motion.div>
```

## Spatial Composition

- Unexpected layouts: asymmetry, overlap, diagonal flow, grid-breaking elements
- Generous negative space OR controlled density — not in-between
- CSS Grid for 2D layouts, Flexbox for 1D

```css
/* Grid-breaking hero layout */
.hero {
  display: grid;
  grid-template-columns: 1fr 1fr;
  grid-template-rows: auto;
}

.hero-text {
  grid-column: 1 / 2;
  grid-row: 1;
  padding: 4rem;
}

.hero-visual {
  grid-column: 2 / 3;
  grid-row: 1 / 3;   /* bleeds into next row */
  position: sticky;
  top: 0;
}
```

## Backgrounds & Atmosphere

Never default to solid colors. Add depth:

```css
/* Gradient mesh */
.bg-mesh {
  background:
    radial-gradient(ellipse at 20% 50%, rgba(120, 80, 255, 0.15) 0%, transparent 50%),
    radial-gradient(ellipse at 80% 20%, rgba(255, 120, 50, 0.1) 0%, transparent 40%),
    #0a0a0a;
}

/* Noise texture overlay */
.bg-noise::after {
  content: '';
  position: absolute;
  inset: 0;
  background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)' opacity='0.04'/%3E%3C/svg%3E");
  pointer-events: none;
}

/* Dramatic card shadow */
.card-elevated {
  box-shadow:
    0 1px 0 rgba(255,255,255,0.05) inset,
    0 20px 60px rgba(0,0,0,0.5),
    0 1px 3px rgba(0,0,0,0.3);
}
```

## Anti-patterns

NEVER do these:
- Purple gradient on white background
- Inter/Roboto as the only font
- Flat, evenly-spaced grid of cards with no hierarchy
- Generic hero: big title, subtitle, two buttons centered
- Shadows only on hover, nowhere else
- Same light blue as accent color
- `border-radius: 8px` on everything uniformly

## Output Format

Always provide:
1. **Aesthetic direction** — one sentence describing the chosen tone
2. **Complete, working code** — no placeholders, no `/* add styles here */`
3. **All CSS variables** defined at `:root`
4. **Fonts** imported at the top
5. For React — note if Motion library is needed (`npm install motion`)
