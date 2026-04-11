You are a coding agent working inside my local `FOLDER WHERE ALL THESE SITES GO`. Your job is to create a brand-new local business site by reusing the best existing repo in this workspace, then fully customizing it into a new production-shaped project end to end.

Core rule:
Before major edits, and after you inspect the workspace enough to understand the likely base repo, always ask me exactly this question:
`Whats the name of the businesss, and what services`

After I answer that question, carry the task through end to end without stopping unless blocked.

What success means:

- A new project exists in the correct folder
- It is based on the best matching local repo
- All old branding is removed
- All text is rewritten for the new business
- All important images are replaced
- The logo, favicon, and OG image are replaced
- The project runs locally
- The project builds successfully
- The project is set up for the correct deployment target
- If Cloudflare is the right target, it uses the same proven Cloudflare pattern as the other working repo in this workspace
- Git is initialized correctly or moved into the already-cloned target repo correctly

Exact workflow to follow:

PHASE 1: Inspect the workspace first

1. Look through the top-level folders in `ProtoSites`.
2. Identify which repos are Astro, which are Node, which are Cloudflare, which are Next, and which are closest in business type and page structure.
3. Find the best-matching source repo for the new project.
4. Do not guess. Check:
   - `package.json`
   - `astro.config.*`
   - `wrangler.toml`
   - `src/pages`
   - `src/components`
   - image folders
   - any scripts folder
5. Use the image prompt JSON, if available to recreate images for the site
6. Reuse proven local patterns from the workspace wherever possible.

PHASE 2: Ask the required question
Once you understand the likely base repo, ask me exactly:
`Whats the name of the businesss, and what services`

Do not skip this.
Do not rewrite this question.
Ask it before the main customization pass.

PHASE 3: Create the new project correctly
After I answer:

1. Pick the best source repo and state briefly why it is the correct base.
2. Duplicate or clone that repo into a new destination folder for the new business.
3. If I already cloned an empty GitHub repo for the target site, move the finished project into that destination and preserve that destination repo’s `.git`.
4. Do not keep the source repo’s `.git` inside the finished target unless I explicitly asked for a fresh local-only repo.
5. If no repo exists yet for the destination, initialize git locally in the finished project.

PHASE 4: Rewrite all business content
You must replace all old business text and location text throughout the project, not just the homepage.
Change all relevant text in:

- homepage
- services index page
- individual service detail pages
- header
- footer
- quote/contact form
- map section
- contact cards
- email templates
- metadata
- Open Graph text
- Twitter card text
- canonical URLs
- geo metadata
- favicon references
- logo alt text
- image alt text
- JSON-LD or schema if present
- README/project name references if they are old-brand-specific

You must remove or replace:

- old business names
- old city/state names
- old region names
- old phone numbers
- old email addresses
- old domain names
- old service area lists
- old map embeds
- old climate-specific claims that no longer fit
- old soil/terrain references that no longer fit
- old brand slogans if they are specific to the previous business

Do not leave half-converted text.
Do a full search pass after edits for leftovers.

PHASE 5: Keep and expand the service pages
If the source repo has a `/services` page and individual service pages, keep that structure.
Make sure these are present and customized:

- `/services`
- one page per service where appropriate

If the source repo had stronger service pages than the destination currently has, recreate those pages in the new project too.

Each service page should feel like a real local landing page:

- localized metadata
- localized headline
- localized body copy
- service-specific FAQs or process copy if the template supports that pattern
- matching CTA
- matching internal links

PHASE 6: Replace all branding assets properly
You must replace old brand-specific visual assets too.

This includes:

- logo
- favicon
- Open Graph image
- any old hero brand image
- any old old-city branded graphics
- any old logo references left in `/public`

Rules:

1. Remove old branded files such as previous logos and old OG images if they are no longer used.
2. Create a new logo for the new brand.
3. Use that new logo in:
   - header
   - footer
   - logo alt text
   - favicon strategy where appropriate
4. Replace the OG image with a new one that matches the new brand.
5. The OG image should not reference the old business visually or in filename usage.
6. Update metadata to point to the new OG asset.
7. Verify the layout file references the correct favicon and OG image.
8. Search `/public` for old brand leftovers and remove them if unused.

For the logo:

- Prefer a clean SVG logo if that is the fastest high-quality result
- It should feel intentional and specific, not placeholder text slapped in
- Match the tone of the site
- If the design direction suggests a wordmark plus mark, do that
- Make sure the logo works on dark and light-ish surfaces used by the site

For the OG image:

- It should be updated to the new business
- It can use a strong site photo plus brand treatment, or a clean branded graphic
- Do not leave the previous city/business OG file in place and just rename text around it

PHASE 7: Reuse and improve the FAL image workflow
Search the workspace for any existing image generation pipeline first.
If a working local script already exists, reuse that approach.

You must:

1. Find the existing FAL or Nano Banana workflow in the workspace, here is my key: be555c80-ef96-4395-bb84-06ee0259d87c:34faec8211391281fa3d6ffb82d00c15.
2. Reuse its shape if it is good.
3. Create a prompt JSON manifest for all needed site photos.
4. Generate unique prompts for each image.
5. Include location, climate, architecture, landscape, and service context in prompts.
6. Generate the images.
7. Convert every final image to `.webp`.
8. Remove or ignore the original generated `.png` or `.jpeg` source files after conversion.
9. Update the site to reference only the final `.webp` images.

Use this placeholder for the key:
`FAL_API_KEY=be555c80-ef96-4395-bb84-06ee0259d87c:34faec8211391281fa3d6ffb82d00c15

Use Nano Banana 2 unless there is a clearly better already-working local pattern you should follow.

Prompt-writing guidance for FAL:

- Be concrete
- Be local
- Be photographic
- Be realistic
- Do not use the same prompt with tiny wording changes

Good ingredients:

- city
- state
- region
- local terrain
- local climate
- architectural style
- lot style
- landscaping style
- exact service context
- time of day
- camera style
- editorial or documentary framing

Good phrases:

- `professional real-estate style photograph`
- `construction documentary photograph`
- `editorial architecture photograph`
- `realistic Central Texas residential setting`
- `clean broom-finish concrete`
- `visible rebar grid`
- `warm late-afternoon light`
- `natural landscaping`
- `no text, no logos, no watermarks`

Bad prompt behavior:

- generic “beautiful house”
- generic “construction site”
- repeated prompts for every file
- fake cinematic fluff with no concrete details
- prompts that conflict with the region

Technical requirements for the image generator:

- use a JSON manifest
- one object per image
- include at least:
  - source reference
  - final filename
  - width
  - height
  - prompt
- add retries
- add timeouts
- make it resumable
- skip already-generated files if rerun
- convert to `.webp`
- clean up temp files

PHASE 8: Cloudflare deployment requirements
You must explicitly check whether the finished project should use the Astro + Cloudflare setup.

Rules:

1. Search the workspace for the repo that already has the working Cloudflare pattern.
2. If a matching local project uses Cloudflare and this new site should too, copy that pattern correctly.
3. Match the existing working local Cloudflare structure rather than improvising.

If Cloudflare is required:

- use `@astrojs/cloudflare`
- add or update `wrangler.toml`
- set the right package scripts for:
  - `preview`
  - `deploy`
- make the Astro adapter Cloudflare
- remove the old Node adapter if the repo used Node before
- install the correct package versions compatible with the project
- verify the build succeeds with the Cloudflare adapter
- note any required bindings clearly

Also:

- check whether sessions or KV bindings are implied by the adapter
- if Cloudflare requires a binding such as `SESSION`, either configure it correctly or clearly note what must still be provided
- do not leave the repo half on Node and half on Cloudflare

PHASE 9: Git and repo handling

1. If the destination is an empty GitHub clone, put the full finished project inside that folder and preserve its `.git`.
2. If the destination is not a repo yet, initialize git locally.
3. Do not leave the final project split across two folders.
4. Do not leave temporary clone folders behind.
5. Do not destroy unrelated repos in `ProtoSites`.

PHASE 10: Verification
You must verify the finished project.

At minimum:

1. Run the local dev server.
2. Verify the homepage loads.
3. Verify `/services` loads.
4. Verify the service detail pages load if they exist.
5. Run the build.
6. If converted to Cloudflare, verify the Cloudflare build path works.
7. Search for leftover old brand text one final time.
8. Search for leftover old brand assets one final time.
9. Confirm the final public image set is `.webp` only where expected.

Communication rules:

- Before substantial work, tell me what you are checking first.
- While working, give short progress updates.
- Before editing files, say what you are about to change.
- If a deployment/config mismatch appears, explain the exact mismatch and fix it.
- If you make a location assumption, say so clearly.
- After understanding the repo and before the main customization pass, always ask:
  `Whats the name of the businesss, and what services`

Quality bar:

- Do not make the site generic
- Do not leave old-brand leftovers
- Do not stop at analysis
- Do the actual edits
- Reuse proven local patterns
- Make it feel like a real finished site, not a quick mockup
