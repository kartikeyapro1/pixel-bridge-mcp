# Example prompts

These assume PixelBridge is connected (see the README).

**Check setup**

> Call PixelBridge get_status and tell me what's configured and what's missing.

**Free: model a prop from a description (no API key needed)**

> Using PixelBridge, read the model spec guide, then build a low-poly wooden treasure chest in
> the "props" category, collection "chest". Render previews, fix anything that looks wrong (at most
> 3 versions), then export a glb and tell me whether it passes the Roblox check.

**Character pipeline (paid image generation)**

> Create an original stylised cartoon fox character for my Roblox game, collection "ember".
> First quote a front/side/back turnaround at medium quality and ask me before spending. Then build
> a Blender model from the references, render previews, compare them with the references and
> refine the spec (up to 4 versions), and export glb + fbx. Report the triangle count and Roblox
> validation.

**Reuse before regenerating**

> List the assets in collection "ember". Use the existing front reference to make a winter-outfit
> variant with edit_image instead of generating from scratch.

**Video reference**

> Quote a 5-second 360p video of the "ember" character doing an idle animation, using its front
> and side references. Don't submit until I approve. Then poll the job and save it.

**Audit**

> Show my PixelBridge budget and the five most recent ledger entries.
