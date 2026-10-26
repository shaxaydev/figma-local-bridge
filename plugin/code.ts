type Props = {
  name?: string; x?: number; y?: number; width?: number; height?: number;
  fill?: string; stroke?: string; strokeWeight?: number; opacity?: number;
  radius?: number; clipsContent?: boolean;
  layout?: 'NONE' | 'HORIZONTAL' | 'VERTICAL'; gap?: number; padding?: number;
  paddingTop?: number; paddingBottom?: number; paddingLeft?: number; paddingRight?: number;
  primaryAlign?: 'MIN' | 'CENTER' | 'MAX' | 'SPACE_BETWEEN';
  counterAlign?: 'MIN' | 'CENTER' | 'MAX';
  horizontalSizing?: 'FIXED' | 'HUG' | 'FILL'; verticalSizing?: 'FIXED' | 'HUG' | 'FILL';
  text?: string; fontFamily?: string; fontStyle?: string; fontSize?: number;
  lineHeight?: number; letterSpacing?: number;
  textAlign?: 'LEFT' | 'CENTER' | 'RIGHT';
  imageBase64?: string;
};
type Spec = Props & {
  type: 'FRAME' | 'RECTANGLE' | 'ELLIPSE' | 'TEXT' | 'SVG' | 'COMPONENT' | 'INSTANCE';
  key?: string; svg?: string; componentId?: string; children?: Spec[];
};
type EditableNode = FrameNode | RectangleNode | EllipseNode | TextNode | ComponentNode | InstanceNode;
type Command = {
  id: string; action: string; targetDocumentId: string;
  pageId?: string; nodeId?: string; parentId?: string; nodeIds?: string[];
  depth?: number; family?: string; nodes?: Spec[];
  updates?: Array<{ nodeId: string; props: Props }>;
  destinationId?: string; scale?: number;
};
const documentId = `figma-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const loadedFonts = new Map<string, Promise<void>>();
const knownNodes = new Map<string, BaseNode>();
function loadFont(font: FontName) {
  const key = `${font.family}\n${font.style}`;
  let pending = loadedFonts.get(key);
  if (!pending) {
    pending = figma.loadFontAsync({family:font.family,style:font.style}).catch(error => {
      loadedFonts.delete(key);
      throw error;
    });
    loadedFonts.set(key,pending);
  }
  return pending;
}
const allowedProps = new Set(['name','x','y','width','height','fill','stroke','strokeWeight','opacity','radius','clipsContent','layout','gap','padding','paddingTop','paddingBottom','paddingLeft','paddingRight','primaryAlign','counterAlign','horizontalSizing','verticalSizing','text','fontFamily','fontStyle','fontSize','lineHeight','letterSpacing','textAlign','imageBase64','type','key','svg','componentId','children']);

function rgb(hex: string): RGB {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) throw new Error('Colors must be #RRGGBB or transparent.');
  return { r: parseInt(hex.slice(1,3),16)/255, g: parseInt(hex.slice(3,5),16)/255, b: parseInt(hex.slice(5,7),16)/255 };
}
function paint(hex: string): Paint[] { return hex === 'transparent' ? [] : [{ type:'SOLID',color:rgb(hex) }]; }
function validateProps(p: Props) {
  for (const [key, value] of Object.entries(p)) {
    if (!allowedProps.has(key)) throw new Error(`Unsupported property: ${key}`);
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(`Invalid number: ${key}`);
  }
  if (p.fill && p.fill !== 'transparent') rgb(p.fill);
  if (p.stroke && p.stroke !== 'transparent') rgb(p.stroke);
  if ((p.width !== undefined && p.width <= 0) || (p.height !== undefined && p.height <= 0)) throw new Error('Dimensions must be positive.');
  if (p.opacity !== undefined && (p.opacity < 0 || p.opacity > 1)) throw new Error('Opacity must be 0..1.');
}
function validateScene(nodes: Spec[], depth = 0, count = { n: 0 }) {
  if (depth > 20) throw new Error('Maximum nesting is 20.');
  for (const n of nodes) {
    if (++count.n > 500) throw new Error('Maximum 500 nodes per creation call.');
    validateProps(n);
    if (!['FRAME','RECTANGLE','ELLIPSE','TEXT','SVG','COMPONENT','INSTANCE'].includes(n.type)) throw new Error(`Unsupported type: ${n.type}`);
    if (n.children?.length && !['FRAME','COMPONENT'].includes(n.type)) throw new Error('Only FRAME and COMPONENT accept children.');
    if (n.children) validateScene(n.children, depth + 1, count);
  }
}
async function getScene(id: string): Promise<SceneNode> {
  const node = knownNodes.get(id) ?? await figma.getNodeByIdAsync(id);
  if (!node || node.removed || node.type === 'DOCUMENT' || node.type === 'PAGE') throw new Error(`Scene node not found: ${id}`);
  knownNodes.set(node.id,node);
  return node;
}
async function apply(node: SceneNode, p: Props) {
  if (node.type !== 'FRAME' && node.type !== 'RECTANGLE' && node.type !== 'ELLIPSE' && node.type !== 'TEXT' && node.type !== 'COMPONENT' && node.type !== 'INSTANCE') throw new Error(`Editing ${node.type} is not supported.`);
  validateProps(p);
  if (node.type === 'TEXT') {
    const fonts = node.getStyledTextSegments(['fontName']).map(s => s.fontName);
    if (!fonts.length && node.fontName !== figma.mixed) fonts.push(node.fontName);
    await Promise.all(fonts.map(loadFont));
    if (p.fontFamily !== undefined || p.fontStyle !== undefined) {
      if (node.fontName === figma.mixed && (!p.fontFamily || !p.fontStyle)) throw new Error('Mixed-font text needs an explicit fontFamily and fontStyle to replace its fonts.');
      const current = node.fontName === figma.mixed ? { family:p.fontFamily!,style:p.fontStyle! } : node.fontName;
      const font = { family:p.fontFamily ?? current.family, style:p.fontStyle ?? current.style };
      await loadFont(font);
      node.fontName = font;
    }
    if (p.text !== undefined) node.characters = p.text;
    if (p.fontSize !== undefined) node.fontSize = p.fontSize;
    if (p.lineHeight !== undefined) node.lineHeight = { unit:'PIXELS',value:p.lineHeight };
    if (p.letterSpacing !== undefined) node.letterSpacing = { unit:'PIXELS',value:p.letterSpacing };
    if (p.textAlign) node.textAlignHorizontal = p.textAlign;
    if (p.width !== undefined) node.textAutoResize = 'HEIGHT';
  }
  if (p.name !== undefined) node.name = p.name;
  if (p.layout && 'layoutMode' in node) node.layoutMode = p.layout;
  if (p.width !== undefined || p.height !== undefined) node.resize(p.width ?? node.width, p.height ?? node.height);
  if (p.x !== undefined) node.x = p.x;
  if (p.y !== undefined) node.y = p.y;
  if (p.fill !== undefined && 'fills' in node) node.fills = paint(p.fill);
  if (p.imageBase64 && 'fills' in node) {
    const image = figma.createImage(figma.base64Decode(p.imageBase64));
    node.fills = [{ type:'IMAGE',imageHash:image.hash,scaleMode:'FILL' }];
  }
  if (p.stroke !== undefined && 'strokes' in node) node.strokes = paint(p.stroke);
  if (p.strokeWeight !== undefined && 'strokeWeight' in node) node.strokeWeight = p.strokeWeight;
  if (p.opacity !== undefined) node.opacity = p.opacity;
  if (p.radius !== undefined && 'cornerRadius' in node) node.cornerRadius = p.radius;
  if (p.clipsContent !== undefined && 'clipsContent' in node) node.clipsContent = p.clipsContent;
  if ('layoutMode' in node) {
    if (p.gap !== undefined) node.itemSpacing = p.gap;
    for (const key of ['paddingTop','paddingBottom','paddingLeft','paddingRight'] as const) {
      if (p[key] !== undefined || p.padding !== undefined) node[key] = p[key] ?? p.padding!;
    }
    if (p.primaryAlign) node.primaryAxisAlignItems = p.primaryAlign;
    if (p.counterAlign) node.counterAxisAlignItems = p.counterAlign;
  }
  if (p.horizontalSizing) node.layoutSizingHorizontal = p.horizontalSizing;
  if (p.verticalSizing) node.layoutSizingVertical = p.verticalSizing;
}
function describe(node: BaseNode, depth: number, budget: { remaining: number }): unknown {
  if (--budget.remaining < 0) return { truncated:true };
  knownNodes.set(node.id,node);
  const out: Record<string,unknown> = { id:node.id,name:node.name,type:node.type };
  if ('width' in node) Object.assign(out,{x:node.x,y:node.y,width:node.width,height:node.height});
  if (node.type === 'TEXT') Object.assign(out,{text:node.characters,fontName:node.fontName === figma.mixed ? 'mixed' : node.fontName,fontSize:node.fontSize === figma.mixed ? 'mixed' : node.fontSize});
  if ('layoutMode' in node) Object.assign(out,{layout:node.layoutMode,gap:node.itemSpacing});
  if ('fills' in node && node.fills !== figma.mixed) out.fills = node.fills;
  if ('children' in node) {
    out.childCount = node.children.length;
    if (depth > 0) out.children = node.children.slice(0,Math.max(0,budget.remaining)).map(c=>describe(c,depth-1,budget));
  }
  return out;
}
async function execute(c: Command): Promise<unknown> {
  if (c.targetDocumentId !== documentId) throw new Error('Target document changed. Read document again before editing.');
  if (c.pageId) {
    const page = figma.root.children.find(p=>p.id === c.pageId);
    if (!page || page.type !== 'PAGE') throw new Error('Page not found.');
    await figma.setCurrentPageAsync(page);
  }
  switch (c.action) {
    case 'document': return {
      documentId, name:figma.root.name, currentPageId:figma.currentPage.id,
      pages:figma.root.children.map(p=>({id:p.id,name:p.name})),
      selection:figma.currentPage.selection.map(n=>n.id),
      tree:describe(c.nodeId ? await getScene(c.nodeId) : figma.currentPage,Math.min(c.depth ?? 2,8),{remaining:500})
    };
    case 'fonts': return (await figma.listAvailableFontsAsync()).filter(f=>!c.family || f.fontName.family.toLowerCase().includes(c.family.toLowerCase()));
    case 'create_nodes': {
      if (!c.nodes?.length) throw new Error('nodes cannot be empty.');
      validateScene(c.nodes);
      const parent = c.parentId ? await figma.getNodeByIdAsync(c.parentId) : figma.currentPage;
      if (!parent || (parent.type !== 'PAGE' && parent.type !== 'FRAME' && parent.type !== 'COMPONENT' && parent.type !== 'SECTION')) throw new Error('Parent must be a page, frame, component, or section.');
      const created: SceneNode[] = []; const keys: Record<string,string> = {};
      async function build(spec: Spec, target: ChildrenMixin): Promise<SceneNode> {
        let n: EditableNode;
        if (spec.type === 'SVG') n = figma.createNodeFromSvg(spec.svg ?? '');
        else if (spec.type === 'INSTANCE') {
          const component = await figma.getNodeByIdAsync(spec.componentId ?? '');
          if (!component || component.type !== 'COMPONENT') throw new Error('componentId must refer to a local component.');
          n = component.createInstance();
        } else if (spec.type === 'FRAME') n = figma.createFrame();
        else if (spec.type === 'RECTANGLE') n = figma.createRectangle();
        else if (spec.type === 'ELLIPSE') n = figma.createEllipse();
        else if (spec.type === 'COMPONENT') n = figma.createComponent();
        else n = figma.createText();
        created.push(n); target.appendChild(n);
        // Child layout sizing must happen after parenting; frame HUG after children are built.
        const {horizontalSizing,verticalSizing,...props} = spec;
        await apply(n,props);
        if (spec.children && 'appendChild' in n) for (const child of spec.children) await build(child,n);
        if (horizontalSizing) n.layoutSizingHorizontal = horizontalSizing;
        if (verticalSizing) n.layoutSizingVertical = verticalSizing;
        if (spec.key) keys[spec.key] = n.id;
        return n;
      }
      try {
        const roots = [];
        for (const spec of c.nodes) roots.push(await build(spec,parent));
        figma.commitUndo();
        return {createdNodeIds:created.map(n=>n.id),keys,roots:roots.map(n=>describe(n,1,{remaining:80}))};
      } catch (error) {
        for (const n of created.reverse()) if (!n.removed) n.remove();
        throw new Error(`Creation rolled back: ${String(error)}`);
      }
    }
    case 'update_nodes': {
      if (!c.updates?.length || c.updates.length > 200) throw new Error('Provide 1–200 updates.');
      for (const u of c.updates) { validateProps(u.props); await getScene(u.nodeId); }
      const changed: string[] = [];
      for (const u of c.updates) {
        try { changed.push(u.nodeId); await apply(await getScene(u.nodeId),u.props); }
        catch (error) { return {error:String(error),possiblyChangedNodeIds:changed,partial:true}; }
      }
      figma.commitUndo(); return {mutatedNodeIds:changed};
    }
    case 'delete_nodes': {
      if (!c.nodeIds?.length || c.nodeIds.length > 200) throw new Error('Provide 1–200 node IDs.');
      const nodes = await Promise.all(c.nodeIds.map(getScene));
      for (const n of nodes) if (!n.removed) n.remove();
      figma.commitUndo(); return {deletedNodeIds:c.nodeIds};
    }
    case 'move_to_page': {
      if (!c.nodeIds?.length || c.nodeIds.length > 50) throw new Error('Provide 1–50 frame IDs.');
      const nodes = await Promise.all(c.nodeIds.map(getScene));
      const selectedIds = new Set(nodes.map(node=>node.id));
      for (const node of nodes) {
        if (node.type !== 'FRAME') throw new Error('Only FRAME nodes can be moved to the page.');
        let ancestor: BaseNode | null = node.parent;
        while (ancestor && ancestor.type !== 'PAGE') {
          if (selectedIds.has(ancestor.id)) throw new Error('Do not move a frame and any selected ancestor together.');
          ancestor = ancestor.parent;
        }
        if (ancestor?.id !== figma.currentPage.id) throw new Error('Frames must belong to the current page.');
      }
      const positions = nodes.map(node => node.absoluteTransform);
      nodes.forEach((node,index) => {
        figma.currentPage.appendChild(node);
        node.relativeTransform = positions[index];
      });
      figma.commitUndo(); return {movedNodeIds:c.nodeIds};
    }
    case 'export_node': {
      const n = await getScene(c.nodeId ?? '');
      const scale = Math.min(c.scale ?? 1, 3, 4096 / Math.max(n.width,n.height));
      const bytes = await n.exportAsync({format:'PNG',constraint:{type:'SCALE',value:scale}});
      return {nodeId:n.id,mimeType:'image/png',base64:figma.base64Encode(bytes)};
    }
    case 'focus': {
      const nodes = await Promise.all((c.nodeIds ?? []).map(getScene));
      figma.currentPage.selection = nodes; figma.viewport.scrollAndZoomIntoView(nodes);
      return {selectedNodeIds:nodes.map(n=>n.id)};
    }
    case 'prototype': {
      const source = await getScene(c.nodeId ?? '');
      const destination = await getScene(c.destinationId ?? '');
      if (destination.type !== 'FRAME' || !('setReactionsAsync' in source)) throw new Error('Prototype needs a reaction-capable source and a FRAME destination.');
      await source.setReactionsAsync([{trigger:{type:'ON_CLICK'},actions:[{type:'NODE',destinationId:destination.id,navigation:'NAVIGATE',transition:{type:'DISSOLVE',easing:{type:'EASE_OUT'},duration:0.2},preserveScrollPosition:false}]}]);
      return {mutatedNodeIds:[source.id]};
    }
    default: throw new Error(`Unknown action: ${c.action}`);
  }
}
let busy = false;
figma.ui.onmessage = async (message: {type?:string; command?:Command}) => {
  if (message.type === 'ready') {
    figma.ui.postMessage({type:'info',documentId,name:figma.root.name,page:figma.currentPage.name}); return;
  }
  if (message.type !== 'command' || !message.command) return;
  const c = message.command;
  if (busy) { figma.ui.postMessage({type:'result',id:c.id,result:{error:'Plugin busy'}}); return; }
  busy = true;
  try { figma.ui.postMessage({type:'result',id:c.id,result:await execute(c)}); }
  catch (error) { figma.ui.postMessage({type:'result',id:c.id,result:{error:String(error)}}); }
  finally { busy = false; }
};
figma.showUI(__html__,{width:360,height:280,themeColors:true});
