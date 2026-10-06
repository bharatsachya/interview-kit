"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The pointer-handling decisions pulled out of the mount effect as plain, side-effect-free
 * functions — the effect below has no DOM-free way to run under a test, since it drives an
 * actual WebGL canvas, but the two decisions that determine what the drag *feels* like (does the
 * idle turn get to run right now, and how quickly does the camera close the distance to a new
 * target) don't need a canvas to check. See `hero-stage-interaction.test.ts`.
 */

/** Whether the idle turn should advance this frame — a drag in progress always wins, reduced
 * motion always loses, and otherwise it's gated by whichever `idleResumeAt` was last set. */
export function shouldIdleRotate(state: {
  reducedMotion: boolean;
  dragging: boolean;
  now: number;
  idleResumeAt: number;
}): boolean {
  return !state.reducedMotion && !state.dragging && state.now >= state.idleResumeAt;
}

/** One frame of exponential ease from `current` toward `target` — used for the camera's framing
 * distance so a post-mount reframe (see the note on `targetDistance` below) settles smoothly
 * instead of snapping. Independent of frame rate: the fraction covered in a given wall-clock
 * duration is the same whether it arrives as one frame or several. */
export function easeToward(current: number, target: number, deltaSeconds: number): number {
  return current + (target - current) * (1 - Math.pow(0.001, deltaSeconds));
}

/**
 * The 3D hero, framed for an auth screen.
 *
 * The standalone export shipped inside a generic `<three-d-stage>` viewer — a download toolbar,
 * OBJ and GLB exporters. None of that belongs next to a sign-in form: an export button on a
 * login page is furniture. So this owns the scene itself and keeps only what a hero needs —
 * studio lighting, a soft ground shadow, a camera framed from the object's own bounds, an idle
 * turn, and a drag to turn it by hand.
 *
 * The drag is scoped to this canvas element alone, via pointer capture — never to `window` or
 * `document`. An earlier version of this file left dragging out entirely, on the worry that a
 * drag control here could steal a drag meant for the password field; that risk doesn't hold once
 * the interaction can't leave the canvas it started on, and the canvas sits in its own grid
 * column with nothing shared with the form beside it.
 *
 * `three` is imported dynamically. It is roughly 600 KB and the form is the reason anyone opened
 * this page, so the form renders and becomes interactive first; the object fades in when it is
 * ready. If the import fails, or WebGL is unavailable, the poster underneath is what stays —
 * which is why the poster is real markup and not a spinner.
 *
 * `prefers-reduced-motion` stops the idle turn. It does not remove the object, and it does not
 * stop a drag: that motion was asked for, not ambient.
 */

export function HeroStage({ className = "" }: { className?: string }) {
  const mount = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const host = mount.current;
    if (host === null) return;

    // Set by the cleanup below. Every async step checks it, because a route change during the
    // dynamic import would otherwise start a render loop against a detached canvas.
    let disposed = false;
    let cleanup: (() => void) | undefined;

    void (async () => {
      let THREE: typeof import("three");
      let buildHero: typeof import("./build-hero").buildHero;
      try {
        [THREE, { buildHero }] = await Promise.all([import("three"), import("./build-hero")]);
      } catch {
        // No object, and the poster stays. Nothing about signing in is blocked by this.
        return;
      }
      if (disposed) return;

      let renderer: import("three").WebGLRenderer;
      try {
        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "low-power" });
      } catch {
        return; // No WebGL. Same outcome as a failed import.
      }

      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.shadowMap.enabled = true;
      // PCFSoft was deprecated in three 0.184 and silently falls back to this anyway.
      renderer.shadowMap.type = THREE.PCFShadowMap;
      renderer.setClearAlpha(0);
      renderer.domElement.style.display = "block";
      renderer.domElement.style.width = "100%";
      renderer.domElement.style.height = "100%";

      const scene = new THREE.Scene();
      const object = buildHero();
      scene.add(object);

      // ── lighting: one key, one fill, one rim, and a ground plane that catches the shadow ──
      scene.add(new THREE.HemisphereLight(0xffffff, 0xd7e2ed, 1.5));

      const key = new THREE.DirectionalLight(0xffffff, 2.1);
      key.position.set(2.4, 3.4, 2.2);
      key.castShadow = true;
      key.shadow.mapSize.set(1024, 1024);
      key.shadow.camera.near = 0.5;
      key.shadow.camera.far = 12;
      key.shadow.camera.left = -3;
      key.shadow.camera.right = 3;
      key.shadow.camera.top = 3;
      key.shadow.camera.bottom = -3;
      key.shadow.bias = -0.0012;
      scene.add(key);

      const fill = new THREE.DirectionalLight(0xeaf0f6, 0.5);
      fill.position.set(-2.6, 1.4, 1.6);
      scene.add(fill);

      const rim = new THREE.DirectionalLight(0xffffff, 0.7);
      rim.position.set(-1.2, 2.0, -2.8);
      scene.add(rim);

      const ground = new THREE.Mesh(
        new THREE.PlaneGeometry(14, 14),
        new THREE.ShadowMaterial({ opacity: 0.14 }),
      );
      ground.rotation.x = -Math.PI / 2;
      ground.receiveShadow = true;
      scene.add(ground);

      // ── camera framed from the object's own bounds, so the model can change without this ──
      const bounds = new THREE.Box3().setFromObject(object);
      const centre = bounds.getCenter(new THREE.Vector3());
      const radius = bounds.getSize(new THREE.Vector3()).length() / 2;

      const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100);
      const pivot = new THREE.Group();
      pivot.position.copy(centre);
      scene.add(pivot);
      pivot.add(camera);

      // The copy plate occupies the top of the panel, so the object is aimed below centre
      // rather than at it: the camera looks at a point above the object's middle, which pushes
      // the object down the frame and leaves the headline clear air.
      const target = centre.clone().setY(centre.y + radius * 0.30);
      const cameraY = radius * 0.5;

      // The distance the render loop eases toward, rather than a value `resize` snaps onto
      // directly. `resize` fires once for the initial layout — framed before the canvas is
      // visible, so snapping there is unseen — and again whenever the panel's own height
      // changes, which includes a beat after mount when Clerk's real form replaces
      // `AuthSkeleton` and settles the shared grid row off the skeleton's reserved height (a
      // sign-up form with more fields routinely does, and the skeleton is only ever a minimum —
      // see `AuthSkeleton`). Snapping the camera on that beat is a pop mid-crossfade; easing it
      // is nothing at all, and a genuine window resize still tracks closely enough to read as
      // immediate.
      let targetDistance = 0;
      let framed = false;

      const resize = () => {
        const { clientWidth: w, clientHeight: h } = host;
        if (w === 0 || h === 0) return;
        camera.aspect = w / h;

        // Fit the bounding sphere in whichever dimension is tighter. The margin is small on
        // purpose — this is the only illustration on the page and it should carry the panel.
        const vFov = (camera.fov * Math.PI) / 180;
        const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
        targetDistance = (radius / Math.sin(Math.min(vFov, hFov) / 2)) * 1.02;

        if (!framed) {
          camera.position.set(0, cameraY, targetDistance);
          framed = true;
        }
        camera.lookAt(target);
        camera.updateProjectionMatrix();
        renderer.setSize(w, h, false);
      };

      const observer = new ResizeObserver(resize);
      observer.observe(host);
      resize();

      host.append(renderer.domElement);
      setReady(true);

      // ── the turn ──────────────────────────────────────────────────────────────────────────
      const stillness = window.matchMedia("(prefers-reduced-motion: reduce)");
      const REST_ANGLE = -0.5;
      pivot.rotation.y = REST_ANGLE;

      // ── drag to turn it by hand ──────────────────────────────────────────────────────────
      // Pointer capture is what keeps this confined to the canvas: once a drag starts here,
      // this element keeps receiving pointermove/pointerup for that pointer no matter where it
      // travels, so a fast drag doesn't fall off the edge of a fairly small canvas. Nothing is
      // ever listened for on `window` or `document`, so a drag can only ever start — and only
      // ever be reported — on this element; the form beside it is untouched either way.
      const canvas = renderer.domElement;
      canvas.style.touchAction = "none";
      canvas.style.cursor = "grab";
      let dragging = false;
      let lastPointerX = 0;
      const DRAG_RADIANS_PER_PIXEL = 0.008;
      const IDLE_RESUME_MS = 1500;
      // 0 lets auto-rotate resume on the very next frame; set ahead of `now` to hold it off.
      let idleResumeAt = 0;

      const onPointerDown = (event: PointerEvent) => {
        dragging = true;
        lastPointerX = event.clientX;
        canvas.setPointerCapture(event.pointerId);
        canvas.style.cursor = "grabbing";
        // Otherwise this reads as a text/image drag or a page-scroll gesture on touch.
        event.preventDefault();
      };
      const onPointerMove = (event: PointerEvent) => {
        if (!dragging) return;
        pivot.rotation.y += (event.clientX - lastPointerX) * DRAG_RADIANS_PER_PIXEL;
        lastPointerX = event.clientX;
      };
      const endDrag = (event: PointerEvent) => {
        if (!dragging) return;
        dragging = false;
        if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
        canvas.style.cursor = "grab";
        idleResumeAt = performance.now() + IDLE_RESUME_MS;
      };
      // A plain hover-out (no drag in progress) resumes the idle turn immediately rather than
      // making someone who merely passed over the object wait out the idle window.
      const onPointerLeave = () => {
        if (!dragging) idleResumeAt = 0;
      };

      canvas.addEventListener("pointerdown", onPointerDown);
      canvas.addEventListener("pointermove", onPointerMove);
      canvas.addEventListener("pointerup", endDrag);
      canvas.addEventListener("pointercancel", endDrag);
      canvas.addEventListener("pointerleave", onPointerLeave);

      let frame = 0;
      let last = performance.now();
      const tick = (now: number) => {
        frame = requestAnimationFrame(tick);
        const delta = Math.min((now - last) / 1000, 0.1);
        last = now;
        // The idle turn only — a drag rotates the pivot directly, above, and keeps working
        // under reduced motion, which stops ambient animation but not requested interaction.
        if (shouldIdleRotate({ reducedMotion: stillness.matches, dragging, now, idleResumeAt })) {
          pivot.rotation.y += delta * 0.16;
        }
        // Ease toward whatever `resize` last set as the target distance, rather than reading
        // it directly — see the note by `targetDistance` above.
        camera.position.z = easeToward(camera.position.z, targetDistance, delta);
        camera.lookAt(target);
        renderer.render(scene, camera);
      };

      // A still frame is drawn either way; only the loop is conditional.
      const start = () => {
        last = performance.now();
        frame = requestAnimationFrame(tick);
      };
      const stop = () => {
        cancelAnimationFrame(frame);
        frame = 0;
        renderer.render(scene, camera);
      };

      const onStillnessChange = () => {
        if (stillness.matches) pivot.rotation.y = REST_ANGLE;
        renderer.render(scene, camera);
      };
      stillness.addEventListener("change", onStillnessChange);

      // A hero animating in a background tab is heat and battery for nobody.
      const onVisibility = () => (document.hidden ? stop() : start());
      document.addEventListener("visibilitychange", onVisibility);
      if (!document.hidden) start();
      else renderer.render(scene, camera);

      cleanup = () => {
        stop();
        observer.disconnect();
        stillness.removeEventListener("change", onStillnessChange);
        document.removeEventListener("visibilitychange", onVisibility);
        canvas.removeEventListener("pointerdown", onPointerDown);
        canvas.removeEventListener("pointermove", onPointerMove);
        canvas.removeEventListener("pointerup", endDrag);
        canvas.removeEventListener("pointercancel", endDrag);
        canvas.removeEventListener("pointerleave", onPointerLeave);
        renderer.domElement.remove();
        // Geometries and materials are created per mount, so they are ours to release. Without
        // this, every visit to the sign-in page leaks a scene's worth of GPU buffers.
        scene.traverse((node) => {
          const mesh = node as import("three").Mesh;
          if (!mesh.isMesh) return;
          mesh.geometry.dispose();
          for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
            material.dispose();
          }
        });
        renderer.dispose();
      };
    })();

    return () => {
      disposed = true;
      cleanup?.();
    };
  }, []);

  return (
    <div className={`relative ${className}`}>
      <HeroPoster hidden={ready} />
      <div
        ref={mount}
        aria-hidden="true"
        className={`absolute inset-0 transition-opacity duration-700 motion-reduce:transition-none ${
          ready ? "opacity-100" : "opacity-0"
        }`}
      />
    </div>
  );
}

/**
 * What is on screen before three.js arrives, and what stays if it never does.
 *
 * The same three beats as the object — a posting, the unit that reads it, the kit that comes
 * out — so the swap is a sharpening rather than a change of subject.
 *
 * The illustration itself breathes while it's the thing on screen — `poster-breathe`, the same
 * vocabulary as `Mark`'s "live" state elsewhere in the product, scaled down for a full
 * illustration rather than a small glyph. This is the first thing a new visitor sees, on the
 * sign-up page before anything else has loaded; a born-still illustration reads as stalled
 * rather than as a page that's getting there. It stops once the object is ready to take over —
 * no reason to keep animating something about to fade out.
 */
function HeroPoster({ hidden }: { hidden: boolean }) {
  return (
    <svg
      viewBox="0 0 1200 800"
      role="img"
      aria-label="A job posting feeding into a unit that produces a stack of prep-kit cards"
      className={`absolute inset-0 h-full w-full transition-opacity duration-500 motion-reduce:transition-none ${
        hidden ? "opacity-0" : "opacity-100"
      }`}
    >
      <g className={hidden ? "" : "motion-safe:animate-poster-breathe"}>
        <rect x="300" y="250" width="150" height="230" fill="#f4f4f5" stroke="#b6cadd" strokeWidth="4" />
        <g fill="#8aa9c6">
          <rect x="322" y="286" width="100" height="12" />
          <rect x="322" y="318" width="100" height="12" />
          <rect x="322" y="350" width="66" height="12" />
        </g>
        <rect x="500" y="270" width="220" height="190" fill="#5980a6" />
        <rect x="494" y="252" width="232" height="22" fill="#2f4359" />
        <rect x="560" y="320" width="100" height="70" fill="#f2f2f3" />
        <text
          x="610"
          y="376"
          fontFamily="var(--font-head)"
          fontSize="62"
          fontWeight="600"
          fill="#5980a6"
          textAnchor="middle"
        >
          P
        </text>
        <rect x="770" y="360" width="130" height="90" fill="#2f4359" transform="rotate(-8 835 405)" />
        <rect x="800" y="290" width="130" height="90" fill="#5980a6" transform="rotate(-2 865 335)" />
        <rect
          x="830"
          y="220"
          width="130"
          height="90"
          fill="#f4f4f5"
          stroke="#b6cadd"
          strokeWidth="4"
          transform="rotate(6 895 265)"
        />
      </g>
    </svg>
  );
}
