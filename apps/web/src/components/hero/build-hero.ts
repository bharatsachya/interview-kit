import * as THREE from "three";

/**
 * The hero object: a posting goes in on the left, a kit comes out on the right.
 *
 * Lifted unchanged from the standalone `three-d-stage` export, so the scene here and the model
 * you can open in Blender are the same geometry — the only thing this app drops is that page's
 * OBJ/GLB export toolbar, which has no business on a sign-in screen.
 *
 * Units are metres and the group sits on y = 0, so `HeroStage` can frame it from its bounding
 * box without knowing anything about what it contains.
 *
 * The palette is the Industry steel ramp. Keep it that way: the object is the only thing on the
 * page besides the form, and a second accent would be one too many.
 */


const M = {
  steel: new THREE.MeshStandardMaterial({ name: 'steel', color: '#5980a6', roughness: 0.5, metalness: 0.25 }),
  deep: new THREE.MeshStandardMaterial({ name: 'deep_steel', color: '#2f4359', roughness: 0.55, metalness: 0.2 }),
  paper: new THREE.MeshStandardMaterial({ name: 'paper', color: '#f4f4f5', roughness: 0.88, metalness: 0.03 }),
  ink: new THREE.MeshStandardMaterial({ name: 'ink', color: '#8aa9c6', roughness: 0.8, metalness: 0.05 }),
  trim: new THREE.MeshStandardMaterial({ name: 'trim', color: '#b7bcc1', roughness: 0.34, metalness: 0.35 })
};

function box(
  w: number,
  h: number,
  d: number,
  m: THREE.Material,
  name: string,
  x = 0,
  y = 0,
  z = 0,
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  mesh.name = name;
  mesh.position.set(x, y, z);
  return mesh;
}

export function buildHero(): THREE.Group {
  const g = new THREE.Group();
  g.name = 'prep_kit_flow';

  // ── the bench everything sits on
  const base = box(2.3, 0.05, 0.95, M.paper, 'bench', 0, 0.025, 0);
  const bandF = box(2.3, 0.012, 0.02, M.steel, 'bench_edge_front', 0, 0.05, 0.475);
  const bandB = box(2.3, 0.012, 0.02, M.steel, 'bench_edge_back', 0, 0.05, -0.475);
  g.add(base, bandF, bandB);

  // ── 1. the posting: a sheet, standing, ruled with lines of text
  const posting = new THREE.Group();
  posting.name = 'job_posting';
  posting.add(box(0.5, 0.68, 0.014, M.paper, 'posting_sheet', 0, 0.34, 0));
  posting.add(box(0.5, 0.06, 0.016, M.steel, 'posting_header', 0, 0.6, 0.001));
  [0.5, 0.44, 0.38, 0.32, 0.26, 0.2, 0.14].forEach((y: number, i: number) => {
    const w = i % 3 === 2 ? 0.24 : 0.36;
    posting.add(box(w, 0.022, 0.016, M.ink, 'posting_line_' + (i + 1), -0.19 + w / 2, y, 0.001));
  });
  posting.position.set(-0.98, 0.05, 0);
  posting.rotation.y = 0.22;
  posting.rotation.x = -0.06;
  g.add(posting);

  // ── 2. the kit builder: one solid block with an intake slot and a badge
  const unit = new THREE.Group();
  unit.name = 'kit_builder';
  unit.add(box(0.78, 0.62, 0.52, M.steel, 'builder_body', 0, 0.31, 0));
  unit.add(box(0.82, 0.05, 0.56, M.deep, 'builder_cap', 0, 0.645, 0));
  unit.add(box(0.82, 0.05, 0.56, M.deep, 'builder_plinth', 0, 0.025, 0));
  // intake slot on the left flank
  unit.add(box(0.03, 0.30, 0.06, M.deep, 'intake_slot', -0.39, 0.36, 0));
  // badge plate on the front
  unit.add(box(0.34, 0.22, 0.02, M.paper, 'badge_plate', 0, 0.36, 0.265));
  const stemX = -0.09;
  unit.add(box(0.035, 0.15, 0.02, M.steel, 'mark_p_stem', stemX, 0.36, 0.28));
  const bowl = new THREE.Mesh(new THREE.TorusGeometry(0.04, 0.015, 14, 32, Math.PI), M.steel);
  bowl.name = 'mark_p_bowl';
  bowl.rotation.z = -Math.PI / 2;
  bowl.position.set(stemX + 0.017, 0.395, 0.28);
  unit.add(bowl);
  [-0.145, 0.145].forEach((dx: number, i: number) => {
    [-0.09, 0.09].forEach((dy: number, j: number) => {
      unit.add(box(0.04, 0.006, 0.01, M.deep, `reg_h_${i}${j}`, dx, 0.36 + dy, 0.278));
      unit.add(box(0.006, 0.04, 0.01, M.deep, `reg_v_${i}${j}`, dx, 0.36 + dy, 0.278));
    });
  });
  // output mouth on the right flank
  unit.add(box(0.03, 0.06, 0.34, M.deep, 'output_mouth', 0.39, 0.5, 0));
  unit.position.set(0.02, 0.05, 0);
  g.add(unit);

  // ── 3. the kit: three cards rising out of the mouth
  const kit = new THREE.Group();
  kit.name = 'the_kit';
  const cards = [
    { m: M.deep, y: 0.26, tilt: -0.14, x: 0.10 },
    { m: M.steel, y: 0.56, tilt: -0.02, x: 0.26 },
    { m: M.paper, y: 0.86, tilt: 0.10, x: 0.42 }
  ];
  cards.forEach((c, i: number) => {
    const card = new THREE.Group();
    card.name = 'kit_card_' + (i + 1);
    card.add(box(0.44, 0.30, 0.014, c.m, 'card_face_' + (i + 1), 0, 0, 0));
    const lineMat = c.m === M.paper ? M.ink : M.paper;
    [0.08, 0.02, -0.04].forEach((ly: number, k: number) => {
      const w = k === 2 ? 0.16 : 0.28;
      card.add(box(w, 0.018, 0.016, lineMat, `card_${i + 1}_line_${k + 1}`, -0.16 + w / 2, ly, 0.001));
    });
    card.position.set(0.72 + c.x, c.y, 0);
    card.rotation.set(0, 0.34, c.tilt);
    kit.add(card);
  });
  g.add(kit);

  // ── the two moves: in, and out
  const arrowIn = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.13, 20), M.trim);
  arrowIn.name = 'arrow_in';
  arrowIn.rotation.z = -Math.PI / 2;
  arrowIn.position.set(-0.44, 0.41, 0);
  const shaftIn = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.16, 16), M.trim);
  shaftIn.name = 'feed_shaft';
  shaftIn.rotation.z = Math.PI / 2;
  shaftIn.position.set(-0.58, 0.41, 0);
  g.add(arrowIn, shaftIn);

  g.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}
