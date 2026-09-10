"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The 3D hero, framed for an auth screen.
 *
 * The standalone export shipped inside a generic `<three-d-stage>` viewer — orbit controls, a
 * download toolbar, OBJ and GLB exporters. None of that belongs next to a sign-in form: a
 * control that steals a drag from someone reaching for a password field is a bug, and an export
 * button on a login page is furniture. So this owns the scene itself and keeps only what a hero
 * needs — studio lighting, a soft ground shadow, a camera framed from the object's own bounds,
 * and a slow turn.
 *
 * `three` is imported dynamically. It is roughly 600 KB and the form is the reason anyone opened
 * this page, so the form renders and becomes interactive first; the object fades in when it is
 * ready. If the import fails, or WebGL is unavailable, the poster underneath is what stays —
 * which is why the poster is real markup and not a spinner.
 *
 * `prefers-reduced-motion` stops the rotation. It does not remove the object: a still render is
 * not the thing motion sensitivity is about.
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

      const resize = () => {
        const { clientWidth: w, clientHeight: h } = host;
        if (w === 0 || h === 0) return;
        camera.aspect = w / h;

        // Fit the bounding sphere in whichever dimension is tighter. The margin is small on
        // purpose — this is the only illustration on the page and it should carry the panel.
        const vFov = (camera.fov * Math.PI) / 180;
        const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
        const distance = (radius / Math.sin(Math.min(vFov, hFov) / 2)) * 1.02;

        camera.position.set(0, radius * 0.5, distance);
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

      let frame = 0;
      let last = performance.now();
      const tick = (now: number) => {
        frame = requestAnimationFrame(tick);
        const delta = Math.min((now - last) / 1000, 0.1);
        last = now;
        if (!stillness.matches) pivot.rotation.y += delta * 0.16;
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
    </svg>
  );
}
