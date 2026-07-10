# docs/

Assets for the project README.

- **`hero.svg`** — the poster shown at the top of the main README. It's a stylized
  mock of the reader in Binnacle's real theme, so the repo looks intentional before
  a real recording exists.

## Replacing the poster with a real demo GIF

A 5–10 second screen recording sells Binnacle far better than a mockup. Record the
core loop and drop it in as `docs/demo.gif`, then point the README hero at it:

1. **Record the loop:** in Claude, say *"add a page tracking my Germany trip with a
   checklist"* → the page appears in the reader → tick a checkbox → ask Claude
   *"what have I checked off?"* and it reads the log back via `get_events`.
2. **Export** as a GIF (or MP4) around 1200px wide. Keep it under ~5 MB so it loads
   fast on GitHub — [Kap](https://getkap.co/), [Gifski](https://gif.ski/), or
   `ffmpeg` all work.
3. **Save** it here as `docs/demo.gif`.
4. **Swap the hero** in the top-level `README.md`:

   ```md
   <img src="docs/demo.gif" alt="Binnacle demo" width="880">
   ```

   (replacing the `docs/hero.svg` line).
