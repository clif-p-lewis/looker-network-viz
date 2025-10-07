// index.js — Force-Directed Network (D3) for Looker Studio
// Uses D3 v7 and Looker Studio Community Viz API (dscc)
// Field mapping (from manifest.json):
// Dimensions: source (req), target (req), group (opt), extraDim1..extraDim5 (opt)
// Metrics: edgeWeight (opt), nodeValue (opt), extraMetric1..extraMetric5 (opt)
// Behavior:
// - Node size: nodeValue (fallback: degree)
// - Link width: edgeWeight (fallback: 1)
// - Node color: group
// - Link color: extraDim1 (fallback: Style.linkColor)
// - Tooltips for nodes & links
// - Zoom/pan & drag

(function () {
  const d3url = 'https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js';

  function ensureD3(cb) {
    if (window.d3) return cb();
    const s = document.createElement('script');
    s.src = d3url;
    s.onload = cb;
    document.head.appendChild(s);
  }

  function ensureRoot() {
    let el = document.getElementById('ls-force-network-root');
    if (!el) {
      el = document.createElement('div');
      el.id = 'ls-force-network-root';
      el.style.width = '100%';
      el.style.height = '100%';
      el.style.position = 'relative';
      document.body.appendChild(el);
    }
    return el;
  }

  function upcase(s) { return (s || '').toString(); }

  function draw(payload) {
    const ds = window.dscc;
    const { tableTransform } = ds;
    const data = payload; // already transformed because we subscribe with tableTransform
    const el = ensureRoot();
    const rect = el.getBoundingClientRect();
    const width = Math.max(100, rect.width || 800);
    const height = Math.max(100, rect.height || 600);

    // Helper: fetch field IDs from manifest-defined fields (by fixed id)
    const dim = {};
    (data.fields.dimensions || []).forEach(f => { dim[f.id] = f.id; });
    const met = {};
    (data.fields.metrics || []).forEach(f => { met[f.id] = f.id; });

    // Required dimensions
    const sourceId = dim.source;
    const targetId = dim.target;

    if (!sourceId || !targetId) {
      el.innerHTML = '<div style="font:12px sans-serif;padding:8px;color:#666">Please map "Source Node" and "Target Node" dimensions.</div>';
      return;
    }

    // Optional fields
    const groupId = dim.group || null;
    const linkGroupId = dim.extraDim1 || null; // used to color links if present

    const edgeWeightId = met.edgeWeight || null;
    const nodeValueId = met.nodeValue || null;

    // Convert rows → edges
    const rows = data.tables.DEFAULT || [];
    if (!rows.length) {
      el.innerHTML = '<div style="font:12px sans-serif;padding:8px;color:#666">No data.</div>';
      return;
    }

    const edges = rows.map(r => ({
      sourceKey: r[sourceId],
      targetKey: r[targetId],
      weight: edgeWeightId ? (+r[edgeWeightId] || 0) : 1,
      linkGroup: linkGroupId ? r[linkGroupId] : null
    }));

    // Build nodes from unique keys
    const nodeMap = new Map();
    function getOrCreateNode(key, r) {
      if (!nodeMap.has(key)) {
        nodeMap.set(key, {
          id: key,
          group: groupId ? r[groupId] : null,
          value: 0,
          degree: 0
        });
      }
      return nodeMap.get(key);
    }

    rows.forEach(r => {
      const s = getOrCreateNode(r[sourceId], r);
      const t = getOrCreateNode(r[targetId], r);
      s.degree += 1; t.degree += 1;
      if (nodeValueId) {
        s.value += (+r[nodeValueId] || 0);
        t.value += (+r[nodeValueId] || 0);
      }
    });

    const nodes = Array.from(nodeMap.values());
    // Fallback: if no nodeValue metric, use degree
    const useDegree = !nodeValueId;
    if (useDegree) nodes.forEach(n => n.value = n.degree);

    // Styles from control panel
    const style = data.style || {};
    const nodeSizeMin = +((style.nodeSizeMin && style.nodeSizeMin.value) ?? 4);
    const nodeSizeMax = +((style.nodeSizeMax && style.nodeSizeMax.value) ?? 26);
    const linkWidthMin = +((style.linkWidthMin && style.linkWidthMin.value) ?? 0.5);
    const linkWidthMax = +((style.linkWidthMax && style.linkWidthMax.value) ?? 6);
    const linkOpacity  = +((style.linkOpacity  && style.linkOpacity.value)  ?? 0.35);
    const linkDistance = +((style.linkDistance && style.linkDistance.value) ?? 70);
    const charge       = +((style.charge       && style.charge.value)       ?? -180);
    const defaultLinkColor = (style.linkColor && style.linkColor.value) || '#999';

    // Color palettes
    const nodePalette = (style.nodeColorScale && style.nodeColorScale.value) || [];
    const d3 = window.d3;

    const nodeGroups = [...new Set(nodes.map(n => n.group).filter(v => v != null && v !== ''))];
    const nodeColor = nodeGroups.length
      ? d3.scaleOrdinal().domain(nodeGroups).range(nodePalette.length ? nodePalette : d3.schemeTableau10)
      : () => '#4e79a7';

    const linkGroups = [...new Set(edges.map(e => e.linkGroup).filter(v => v != null && v !== ''))];
    const linkColorScale = linkGroups.length
      ? d3.scaleOrdinal().domain(linkGroups).range(d3.schemeTableau10)
      : null;

    // Scales
    const vExtent = d3.extent(nodes, d => d.value);
    const nodeSize = d3.scaleSqrt()
      .domain(vExtent[0] === vExtent[1] ? [0, vExtent[1] || 1] : vExtent)
      .range([nodeSizeMin, nodeSizeMax]);

    const wExtent = d3.extent(edges, e => e.weight);
    const linkWidth = d3.scaleLinear()
      .domain(wExtent[0] === wExtent[1] ? [0, wExtent[1] || 1] : wExtent)
      .range([linkWidthMin, linkWidthMax]);

    // Clear and draw
    el.innerHTML = '';

    // Tooltip
    const tip = document.createElement('div');
    tip.style.position = 'absolute';
    tip.style.pointerEvents = 'none';
    tip.style.padding = '6px 8px';
    tip.style.background = 'rgba(0,0,0,0.75)';
    tip.style.color = '#fff';
    tip.style.borderRadius = '6px';
    tip.style.font = '12px/1.3 sans-serif';
    tip.style.opacity = '0';
    tip.style.transition = 'opacity 120ms ease';
    el.appendChild(tip);

    const svg = d3.select(el).append('svg')
      .attr('width', width)
      .attr('height', height);

    // Zoom/pan
    const g = svg.append('g');
    svg.call(d3.zoom().on('zoom', (ev) => g.attr('transform', ev.transform)));

    // Build link force id accessor
    const idAccessor = d => d.id;

    // Convert edges' source/target from keys to node objects after simulation starts
    const linksData = edges.map(e => ({ ...e }));

    // Links
    const link = g.append('g')
      .attr('stroke-linecap', 'round')
      .selectAll('line')
      .data(linksData)
      .join('line')
      .attr('stroke', d => linkColorScale ? linkColorScale(d.linkGroup) : defaultLinkColor)
      .attr('stroke-opacity', linkOpacity)
      .attr('stroke-width', d => linkWidth(d.weight));

    // Nodes
    const node = g.append('g')
      .selectAll('circle')
      .data(nodes)
      .join('circle')
      .attr('r', d => nodeSize(d.value))
      .attr('fill', d => nodeColor(d.group))
      .attr('stroke', '#fff')
      .attr('stroke-width', 1.2)
      .call(dragBehavior());

    // Accessibility titles (fallback)
    node.append('title').text(d => `${upcase(d.id)}${d.group ? `\nGroup: ${d.group}` : ''}\nValue: ${d.value}`);

    // HTML tooltips
    node.on('mousemove', (event, d) => {
      tip.innerHTML = `
        <div><strong>${upcase(d.id)}</strong></div>
        ${d.group ? `<div>Group: ${d.group}</div>` : ''}
        <div>${useDegree ? 'Degree' : 'Value'}: ${d.value}</div>
      `;
      positionTip(tip, event, el);
      tip.style.opacity = '1';
    }).on('mouseout', () => { tip.style.opacity = '0'; });

    link.on('mousemove', (event, d) => {
      const s = d.sourceKey?.id || d.source?.id || d.sourceKey;
      const t = d.targetKey?.id || d.target?.id || d.targetKey;
      tip.innerHTML = `
        <div><strong>${upcase(s)} ⇄ ${upcase(t)}</strong></div>
        <div>Weight: ${d.weight}</div>
        ${d.linkGroup ? `<div>Link group: ${d.linkGroup}</div>` : ''}
      `;
      positionTip(tip, event, el);
      tip.style.opacity = '1';
    }).on('mouseout', () => { tip.style.opacity = '0'; });

    // Simulation
    const sim = d3.forceSimulation(nodes)
      .force('link', d3.forceLink(linksData).id(idAccessor).distance(linkDistance).strength(0.6))
      .force('charge', d3.forceManyBody().strength(charge))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .on('tick', () => {
        link
          .attr('x1', d => (d.source.x))
          .attr('y1', d => (d.source.y))
          .attr('x2', d => (d.target.x))
          .attr('y2', d => (d.target.y));

        node
          .attr('cx', d => d.x)
          .attr('cy', d => d.y);
      });

    function dragBehavior() {
      function dragstarted(event, d) {
        if (!event.active) sim.alphaTarget(0.2).restart();
        d.fx = d.x; d.fy = d.y;
      }
      function dragged(event, d) {
        d.fx = event.x; d.fy = event.y;
      }
      function dragended(event, d) {
        if (!event.active) sim.alphaTarget(0);
        d.fx = null; d.fy = null;
      }
      return d3.drag().on('start', dragstarted).on('drag', dragged).on('end', dragended);
    }

    function positionTip(tipEl, evt, container) {
      const pad = 12;
      const bounds = container.getBoundingClientRect();
      const x = evt.clientX - bounds.left + pad;
      const y = evt.clientY - bounds.top + pad;
      tipEl.style.left = `${x}px`;
      tipEl.style.top = `${y}px`;
    }
  }

  // Subscribe once D3 is ready
  function subscribe() {
    window.dscc.subscribeToData(draw, { transform: window.dscc.tableTransform });
  }

  if (!window.dscc) {
    // Looker Studio injects dscc; this guard is mostly for local testing
    Object.defineProperty(window, 'dscc', {
      get() { return undefined; },
      set(v) {
        Object.defineProperty(window, 'dscc', { value: v, writable: false });
        ensureD3(subscribe);
      },
      configurable: true
    });
  } else {
    ensureD3(subscribe);
  }
})();
