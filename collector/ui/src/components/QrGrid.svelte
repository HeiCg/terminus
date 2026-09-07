<script lang="ts">
  // Renders a QR module matrix as one inline SVG path — a single node for the
  // dark modules (crisp-edged, so no anti-alias seams between cells) over a solid
  // light background rect. Dark modules paint in --fg-primary on --bg-base so the
  // code reads regardless of the surrounding surface. `size` is the pixel side;
  // one module is size / n.
  type Props = { matrix: boolean[][]; size?: number };
  let { matrix, size = 96 }: Props = $props();

  const n = $derived(matrix.length);

  // Accumulate every dark module into one path `d`. Coordinates are in module
  // units (viewBox is 0 0 n n), so the path is resolution-independent.
  const path = $derived.by(() => {
    let d = '';
    for (let r = 0; r < matrix.length; r++) {
      const row = matrix[r];
      for (let c = 0; c < row.length; c++) {
        if (row[c]) d += `M${c} ${r}h1v1h-1z`;
      }
    }
    return d;
  });
</script>

<svg
  class="qr"
  width={size}
  height={size}
  viewBox="0 0 {n} {n}"
  shape-rendering="crispEdges"
  role="img"
  aria-label="Pairing QR code"
>
  <rect class="bg" x="0" y="0" width={n} height={n} />
  <path class="modules" d={path} />
</svg>

<style>
  .qr {
    display: block;
    border-radius: var(--radius-sm);
  }
  .bg {
    fill: var(--bg-base);
  }
  .modules {
    fill: var(--fg-primary);
  }
</style>
