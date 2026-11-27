'use strict';
(() => {
  const vscode = acquireVsCodeApi();
  const tr = (zh, en) => document.documentElement.lang.toLowerCase().startsWith('zh') ? zh : en;
  const el = id => document.getElementById(id);
  let busy = false, trigger = null;
  let operation = '', selected = '', draftKind = '', groups = [], hasPendingKey = false, baseline;
  let dirty = false, readFailed = false, operationResult = false, auxiliaryChosen = false;
  function renderStatus() {
    const state = !busy ? (dirty ? 'dirty' : 'clean') : operation === 'apply' ? 'saving' : 'busy';
    const labels = {
      clean: tr('没有未保存的更改', 'No unsaved changes'), dirty: tr('有未保存的更改', 'Unsaved changes'),
      saving: tr('正在保存…', 'Saving…'), busy: tr('正在处理…', 'Working…')
    };
    const status = el('saveState');
    status.dataset.state = state;
    if (status.textContent !== labels[state]) status.textContent = labels[state];
    const discoveryReason = !el('defaultUrl').value.trim() ? tr('获取列表需要默认接口地址。', 'Enter a default URL to fetch models.')
      : !['responses', 'chat-completions'].includes(el('apiType').value) ? tr('获取列表需要 Responses 或 Chat Completions 协议。', 'Fetching models requires Responses or Chat Completions.') : '';
    el('discoverModels').disabled = busy || Boolean(discoveryReason);
    el('discoveryHint').textContent = discoveryReason;
    el('discoveryHint').hidden = !discoveryReason;
    el('switchGroup').disabled = busy || !groups.length;
    el('connectionEndpoint').textContent = endpointLabel();
    el('connectionProtocol').textContent = protocolLabels.get(el('apiType').value) || tr('未设置', 'Not set');
    renderKeyStatus();
    el('apply').disabled = busy || readFailed;
    el('apply').textContent = state === 'saving' ? labels.saving : tr('备份并写入', 'Save with Backup');
  }
  function updateDirty() {
    const current = form();
    dirty = hasPendingKey || ['new', 'import', 'preset'].includes(draftKind) ||
      (!!baseline && Object.keys(current).some(key => current[key] !== baseline[key]));
    renderStatus();
  }
  function lock(next) {
    busy = Boolean(next); operation = next || '';
    document.querySelectorAll('button, input, select, textarea').forEach(control => { control.disabled = busy; });
    renderStatus();
  }
  function send(type, rest = {}) {
    if (busy || (type === 'apply' && readFailed)) return;
    trigger = document.activeElement?.tagName === 'BUTTON' ? document.activeElement : null;
    if (['import', 'export', 'validate', 'refresh'].includes(type) && el('modelTools').open) {
      trigger = closeTools();
    }
    operationResult = false;
    lock(type);
    notice('');
    vscode.postMessage({ type, ...rest });
  }
  function form() {
    return {
      auxiliaryModel: el('auxiliaryModel').value, name: el('name').value, apiType: el('apiType').value, defaultUrl: el('defaultUrl').value,
      modelsText: el('modelsText').value, noAuth: el('noAuth').checked,
      stateless: el('stateless').checked, applyRecommendedSettings: el('applyRecommendedSettings').checked,
      overwriteRecommendedSettings: el('overwriteRecommendedSettings').checked
    };
  }
  function notice(text, kind = 'info') {
    const node = el('notice'); node.textContent = text; node.className = 'notice ' + kind; node.hidden = !text;
  }
  const protocolLabels = new Map([['responses', 'Responses'], ['chat-completions', 'Chat Completions'], ['messages', 'Messages']]);
  function endpointLabel() {
    const url = el('defaultUrl').value.trim();
    if (!url) {
      return displayedModels?.some(model => typeof model.url === 'string' && model.url.trim())
        ? tr('按模型设置', 'Per-model URLs') : tr('未设置', 'Not set');
    }
    try {
      const parsed = new URL(url);
      // Never reflect credentials, paths, query strings, or invalid pasted input in the header.
      if (['http:', 'https:'].includes(parsed.protocol) && parsed.host) return parsed.origin;
    } catch { /* An incomplete URL is normal while typing. */ }
    return tr('地址无效', 'Invalid URL');
  }
  function renderKeyStatus() {
    const noAuth = el('noAuth').checked, target = el('name').value.trim();
    const reusable = !readFailed && groups.some(group => group.name === target && group.hasKey === true);
    const text = noAuth ? tr('保存时不使用 API Key。', 'Save without an API key.')
      : hasPendingKey ? tr('新密钥已暂存，保存后生效。', 'New key entered; pending save.')
      : readFailed || !draftKind ? tr('本机密钥引用状态未知。', 'Local key reference status is unknown.')
      : reusable ? tr('上次读取时已有密钥引用，保存时可复用。', 'Local key reference found at last load; available for reuse.')
      : tr('上次读取时，此名称下没有密钥引用。', 'No local key reference for this name at last load.');
    el('connectionCredential').textContent = noAuth ? tr('无需密钥', 'No key needed')
      : hasPendingKey ? tr('已暂存', 'Pending save') : readFailed || !draftKind ? tr('未知', 'Unknown')
      : reusable ? tr('可复用', 'Reusable key') : tr('未录入', 'No key reference');
    if (el('keyStatus').textContent !== text) el('keyStatus').textContent = text;
    const enter = el('setKey'), clear = el('clearKey');
    enter.textContent = reusable || hasPendingKey ? tr('替换 API Key', 'Replace API Key') : tr('录入 API Key', 'Enter API Key');
    enter.hidden = noAuth; enter.disabled = busy || noAuth;
    clear.hidden = !hasPendingKey; clear.disabled = busy || !hasPendingKey;
  }
  function renderGroupContext() {
    const labels = { existing: tr('当前模型组', 'Current group'), new: tr('新建草稿', 'New draft'), import: tr('导入草稿', 'Imported draft'), preset: tr('预设草稿', 'Preset draft') };
    el('groupKind').textContent = labels[draftKind];
    el('groupName').textContent = (draftKind === 'existing' ? selected : el('name').value.trim()) || tr('未命名', 'Unnamed');
  }
  let editing = null;
  let deleteIndex = null;
  let mergePending = false;
  const number = v => v == null ? '—' : typeof v === 'number' ? v.toLocaleString('en-US') : String(v);
  const node = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  function readModels() {
    const models = JSON.parse(el('modelsText').value);
    if (!Array.isArray(models) || models.some(m => !m || typeof m !== 'object' || Array.isArray(m))) throw new Error(tr("模型配置必须是对象数组。", "Model configuration must be an array of objects."));
    return models;
  }
  let displayedModels = [];
  function setModels(models) { el('modelsText').value = JSON.stringify(models, null, 2); modelsChanged(); }
  function modelsChanged() { count(); updateDirty(); }
  function count() {
    const problem = el('modelProblem');
    try { displayedModels = readModels(); problem.hidden = true; }
    catch { displayedModels = null; problem.hidden = false; problem.textContent = tr("无法解析模型列表，请在高级配置中修复 JSONC 或点击“格式化并解析”。", "Cannot parse models. Fix JSONC or select Format and Parse."); }
    const aux = el('auxiliaryModel'), previousAux = aux.value;
    if (displayedModels) {
      aux.replaceChildren(new Option(tr("不修改模型选择器", "Keep existing model selectors"), ''));
      for (const m of displayedModels) if (typeof m.id === 'string' && m.id) aux.add(new Option(m.name || m.id, m.id));
      aux.value = displayedModels.some(m => m.id === previousAux) ? previousAux : '';
    }
    const size = displayedModels?.length;
    const total = size === undefined ? '—' : tr(`${size} 个模型`, `${size} ${size === 1 ? 'model' : 'models'}`);
    el('modelCount').textContent = String(size ?? '—'); el('groupCount').textContent = total;
    renderModels();
  }
  const columns = [tr("模型 / ID", "Model / ID"), tr("协议", "Protocol"), tr("上下文 / 输出", "Context / Output"), tr("能力 / 思考档位", "Capabilities / Effort"), tr("操作", "Actions")];
  function dismiss(details, restoreFocus = false) {
    const summary = details.querySelector('summary');
    details.open = false;
    if (restoreFocus) summary.focus();
    return summary;
  }
  function closeTools() { return dismiss(el('modelTools'), true); }
  function dismissOnEscape(details) {
    details.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || !details.open) return;
      event.preventDefault(); event.stopPropagation(); dismiss(details, true);
    });
  }
  for (const id of ['connectionEditor', 'modelTools', 'builder', 'advanced']) dismissOnEscape(el(id));
  document.addEventListener('click', event => {
    for (const menu of document.querySelectorAll('details.row-more[open], #modelTools[open]')) {
      if (!menu.contains(event.target)) dismiss(menu);
    }
  });
  function renderModels() {
    const list = el('modelList');
    if (!displayedModels) { list.replaceChildren(node('div','empty',tr("可视化列表暂不可用", "Visual model list unavailable"))); return; }
    const query = el('searchModels').value.trim().toLowerCase();
    const table = node('table', 'model-table'), thead = node('thead'), tbody = node('tbody');
    const heading = node('tr', 'model-heading');
    for (const label of columns) { const th = node('th', '', label); th.scope = 'col'; heading.append(th); }
    thead.append(heading); table.append(node('caption', 'sr-only', tr('模型列表', 'Models')), thead, tbody);
    let visible = 0;
    displayedModels.forEach((model, i) => {
      if (query && !`${model.name || ''} ${model.id || ''}`.toLowerCase().includes(query)) return;
      visible++;
      const row = node('tr','model-item'), body = node('td','model-body');
      const name = node('div','model-name',model.name || model.id || tr("未命名模型", "Unnamed model"));
      const id = node('div','model-id',model.id || tr("缺少 ID", "Missing ID"));
      name.title = name.textContent; id.title = id.textContent; body.append(name, id);
      const apiType = model.apiType || el('apiType').value;
      const protocol = node('td', 'model-protocol', protocolLabels.get(apiType) || String(apiType));
      if (!model.apiType) protocol.append(node('div','model-id',tr("继承组协议", "Inherited protocol")));
      const meta = node('td','model-meta');
      meta.append(node('span','',number(model.contextWindow)),node('span','model-id',tr("输出 ", "Output ")+number(model.maxOutputTokens)));
      if (model.maxInputTokens !== undefined) meta.append(node('span','model-id',tr("输入 ", "Input ")+number(model.maxInputTokens)));
      const caps = node('td','model-cap');
      const supported = [['toolCalling',tr("工具", "Tools")],['vision',tr("视觉", "Vision")],['thinking',tr("思考", "Reasoning")]].filter(([key])=>model[key]===true).map(([,label])=>label);
      caps.append(node('div','',supported.join(' · ') || '—'));
      if (Array.isArray(model.supportsReasoningEffort) && model.supportsReasoningEffort.length) {
        const levels = model.supportsReasoningEffort, effort = node('details', 'model-effort');
        effort.append(node('summary', '', tr(`${levels.length} 档`, `${levels.length} ${levels.length === 1 ? 'level' : 'levels'}`)), node('div', 'model-id', levels.join(' / ')));
        caps.append(effort);
      }
      const actions = node('td','model-actions'), more = node('details', 'row-more');
      const summary = node('summary', '', tr('更多…', 'More…')), secondary = node('div', 'row-more-actions');
      const targetName = model.name || model.id || tr('模型', 'Model');
      summary.setAttribute('aria-label', tr(`${targetName} 的更多操作`, `More actions for ${targetName}`));
      more.append(summary, secondary); dismissOnEscape(more);
      for (const [label, mode] of [[tr("编辑", "Edit"),'edit'],[tr("复制", "Copy"),'copy'],[tr("删除", "Delete"),'delete']]) {
        const b = node('button','row-action'+(mode==='delete'?' danger':''),label); b.type='button'; b.disabled = busy; b.setAttribute('aria-label',`${label} ${targetName}`);
        b.addEventListener('click', () => {
          if (busy) return;
          if (mode !== 'edit') dismiss(more, true);
          if (mode !== 'delete') { openEditor(mode, i); return; }
          deleteIndex = i;
          el('deleteDescription').textContent = tr(`确认移除 ${targetName}？`, `Remove ${targetName}?`);
          el('deleteDialog').showModal();
        });
        (mode === 'edit' ? actions : secondary).append(b);
      }
      actions.append(more);
      const cells = [body, protocol, meta, caps, actions];
      cells.forEach((cell, index) => { cell.dataset.label = columns[index]; });
      row.append(...cells); tbody.append(row);
    });
    if (!visible) {
      const empty = node('td', 'empty', displayedModels.length ? tr('没有匹配的模型', 'No matching models') : tr('暂无模型', 'No models'));
      empty.colSpan = columns.length;
      const row = node('tr'); row.append(empty); tbody.append(row);
    }
    list.replaceChildren(table);
  }
  function fieldError(id, text) { const n=el(id); n.textContent=text; n.hidden=!text; }
  const efforts = () => [...new Set(el('editEffort').value.split(/[\s,，;；]+/).map(x=>x.trim()).filter(Boolean))];
  function effortState() { const current=efforts(); el('effortButtons').querySelectorAll('button').forEach(b=>b.setAttribute('aria-pressed',String(current.includes(b.textContent)))); }
  for (const value of ['none','minimal','low','medium','high','xhigh','max']) {
    const b=node('button','quiet',value); b.type='button'; b.addEventListener('click',()=>{ const current=efforts(); el('editEffort').value=(current.includes(value)?current.filter(x=>x!==value):[...current,value]).join(', '); effortState(); }); el('effortButtons').append(b);
  }
  el('editEffort').addEventListener('input',effortState);
  function openEditor(mode, index=-1) {
    try {
      const models=readModels(); const base=mode==='new'?{}:models[index];
      if (!base) throw new Error(tr("模型不存在，请重新读取。", "Model not found. Reload first."));
      editing={mode,index,base};
      el('editorTitle').textContent=mode==='edit'?tr("编辑模型", "Edit Model"):mode==='copy'?tr("复制模型", "Copy Model"):tr("添加模型", "Add Model");
      const values={editId:mode==='copy'?'':base.id, editName:base.name,editUrl:base.url,editApiType:base.apiType,editThinking:base.thinking,editContext:base.contextWindow,editInput:base.maxInputTokens,editOutput:base.maxOutputTokens,editStateful:base.statefulResponses,editEffort:Array.isArray(base.supportsReasoningEffort)?base.supportsReasoningEffort.join(', '):''};
      for (const [key,value] of Object.entries(values)) el(key).value=value??'';
      el('editTool').checked=base.toolCalling===true; el('editVision').checked=base.vision===true;
      fieldError('editorError',''); effortState(); el('modelDialog').showModal(); el('editId').focus();
    } catch(e) { notice(tr("请先修复高级 JSONC 配置，再进行可视化编辑。", "Fix advanced JSONC before using the visual editor."),'error'); }
  }
  el('createModel').addEventListener('click',()=>openEditor('new'));
  for (const id of ['closeEditor','cancelEditor']) el(id).addEventListener('click',()=>el('modelDialog').close());
  el('modelDialog').addEventListener('close',()=>{editing=null;});
  el('modelForm').addEventListener('submit',event=>{
    event.preventDefault(); if (!editing || busy) return;
    try {
      const models=readModels(), {mode,index,base}=editing, id=el('editId').value.trim();
      if (!id || /[\x00-\x1f\x7f]/.test(id)) throw new Error(tr("请填写有效的模型 ID。", "Enter a valid model ID."));
      if (models.some((m,i)=>m.id===id && !(mode==='edit' && i===index))) throw new Error(tr("该模型 ID 已存在。", "This model ID already exists."));
      if (mode!=='edit' && models.length>=300) throw new Error(tr("最多支持 300 个模型。", "A maximum of 300 models is supported."));
      const model={...base,id,name:el('editName').value.trim()||id,toolCalling:el('editTool').checked,vision:el('editVision').checked};
      const set=(key,value)=>{if(value===undefined||value==='') delete model[key];else model[key]=value;};
      const url=el('editUrl').value.trim(); const inherited=el('defaultUrl').value.trim();
      if (!url&&!inherited) throw new Error(tr("填写模型接口地址，或先设置公共地址。", "Enter a model endpoint or set the shared URL first."));
      let parsed; try { parsed=new URL(url||inherited); } catch {throw new Error(tr("接口地址无效。", "Invalid endpoint URL."));}
      if (!['http:','https:'].includes(parsed.protocol)||parsed.username||parsed.password||parsed.search||parsed.hash) throw new Error(tr("接口地址须为不含凭据、查询参数和片段的 HTTP(S) URL。", "Endpoint must be an HTTP(S) URL without credentials, query parameters or fragments."));
      set('url',url); set('apiType',el('editApiType').value);
      for (const [key,field] of [['thinking','editThinking'],['statefulResponses','editStateful']]) { const v=el(field).value; set(key,v===''?undefined:v==='true'); }
      for (const [key,field] of [['contextWindow','editContext'],['maxInputTokens','editInput'],['maxOutputTokens','editOutput']]) {const v=el(field).value; if(v!==''&&(!Number.isSafeInteger(Number(v))||Number(v)<=0)) throw new Error(tr("Token 上限必须为正整数。", "Token limits must be positive integers."));set(key,v===''?undefined:Number(v));}
      if (!model.maxOutputTokens || (!model.contextWindow&&!model.maxInputTokens)) throw new Error(tr("请填写最大输出，以及总上下文或最大输入。", "Enter maximum output and either total context or maximum input."));
      if (model.contextWindow && (model.contextWindow<=model.maxOutputTokens || (model.maxInputTokens && model.maxInputTokens+model.maxOutputTokens>model.contextWindow))) throw new Error(tr("总上下文必须大于输出，且不能小于输入与输出之和。", "Total context must exceed output and be at least input plus output."));
      const e=efforts(); set('supportsReasoningEffort',e.length?e:(Array.isArray(base.supportsReasoningEffort)&&base.supportsReasoningEffort.length===0?[]:undefined));
      if(mode==='edit') models[index]=model; else models.push(model);
      el('searchModels').value=''; setModels(models); el('modelDialog').close();
      el('modelList').querySelectorAll('.model-actions')[mode === 'edit' ? index : models.length - 1]?.querySelector('button')?.focus();
      notice(dirty ? tr("模型已修改，尚未保存。", "Model changed; not saved.") : '');
    } catch(e) {fieldError('editorError',e.message);}
  });
  el('cancelDelete').addEventListener('click',()=>el('deleteDialog').close());
  el('deleteDialog').addEventListener('close',()=>{deleteIndex=null;});
  el('confirmDelete').addEventListener('click', () => {
    if (deleteIndex === null || busy) return;
    const models = readModels(); models.splice(deleteIndex, 1); setModels(models);
    el('deleteDialog').close(); el('searchModels').focus();
    notice(dirty ? tr('模型已移除，尚未保存。', 'Model removed; not saved.') : '');
  });
  el('name').addEventListener('input', renderGroupContext);
  el('searchModels').addEventListener('input',renderModels);
  el('apiType').addEventListener('change',renderModels);
  for (const id of ['name', 'defaultUrl']) el(id).addEventListener('input', updateDirty);
  el('auxiliaryModel').addEventListener('change', () => { auxiliaryChosen = true; });
  for (const id of ['apiType', 'auxiliaryModel', 'noAuth', 'stateless', 'applyRecommendedSettings', 'overwriteRecommendedSettings']) el(id).addEventListener('change', updateDirty);
  el('openMerge').addEventListener('click',()=>{try {readModels(); el('mergeText').value='';el('replaceDuplicates').checked=false;fieldError('mergeError','');closeTools();el('mergeDialog').showModal();}catch{notice(tr("请先格式化或修复当前 JSONC。", "Format or fix the current JSONC first."),'error');}});
  for(const id of ['closeMerge','cancelMerge']) el(id).addEventListener('click',()=>{if(!busy)el('mergeDialog').close();});
  el('mergeDialog').addEventListener('cancel',e=>{if(busy)e.preventDefault();});
  el('mergeModels').addEventListener('click',()=>{if(busy)return;mergePending=true;fieldError('mergeError','');send('mergeModels',{form:form(),incomingText:el('mergeText').value,replace:el('replaceDuplicates').checked});});
  window.addEventListener('message', event => {
    const message = event.data;
    if (!message || typeof message.type !== 'string') return;
    if (message.type === 'busy') {
      if (message.value === true) {
        if (!busy || message.operation && operation !== message.operation) { operationResult = false; notice(''); }
        lock(message.operation || operation || 'host');
      } else {
        if (!operationResult && operation === 'apply') notice(tr('已取消保存。', 'Save cancelled.'));
        if (!operationResult && operation === 'restore') notice(tr('已取消恢复。', 'Restore cancelled.'));
        const completed = operation;
        lock(''); mergePending = false;
        let target = trigger;
        if (completed === 'switchGroup') target = el(el('switchGroup').disabled ? 'refresh' : 'switchGroup');
        if (completed === 'discoverModels') target = el('discoverModels').disabled ? el('connectionEditor').querySelector('summary') : el('discoverModels');
        if (completed === 'clearKey' && el('clearKey').hidden) target = el(el('setKey').hidden ? 'noAuth' : 'setKey');
        if (completed === 'mergeModels' && !el('mergeDialog').open) target = el('modelTools').querySelector('summary');
        // A native disclosure can still be navigated while form controls are locked.
        const active = document.activeElement;
        if (target && !target.disabled && !target.hidden && (!active || active === document.body || active === trigger || active === target)) target.focus();
        trigger = null;
      }
    } else if (message.type === 'notice') {
      operationResult = true; notice(message.text, message.kind);
      if (operation === 'refresh' && message.kind === 'error') readFailed = true;
      if (mergePending && message.kind === 'error') fieldError('mergeError', message.text);
    }
    else if (message.type === 'models') {
      if (operation === 'discoverModels') el('searchModels').value = '';
      el('modelsText').value = message.text; modelsChanged();
    }
    else if (message.type === 'merged') { el('modelsText').value=message.text; el('searchModels').value='';modelsChanged();el('mergeDialog').close();mergePending=false; }
    else if (message.type === 'key') { hasPendingKey = message.pending === true; updateDirty(); }
    else if (message.type === 'state') {
      const env = message.env;
      const ok = env.openJson && env.provider && env.trusted && env.desktop && !env.aiDisabled;
      el('environment').textContent = `VS Code ${env.version} · ` + (ok ? tr("Custom Endpoint 可用", "Custom Endpoint available") : tr("兼容性检查未通过，请查看环境诊断", "Compatibility check failed; see Diagnostics"));
      el('environment').className = 'environment' + (ok ? '' : ' warning');
      operationResult = true;
      readFailed = Boolean(message.error);
      if (readFailed && baseline && ['refresh', 'apply', 'restore'].includes(operation)) {
        // A failed read supplied a fallback template, not a fresh disk baseline.
        hasPendingKey = message.hasPendingKey === true;
        notice(message.error, 'error'); updateDirty(); return;
      }
      groups = message.groups;
      selected = message.selected || '';
      draftKind = message.draftKind || (selected ? 'existing' : 'new');
      el('connectionEditor').open = draftKind !== 'existing';
      for (const id of ['modelDialog', 'deleteDialog', 'mergeDialog']) if (el(id).open) el(id).close();
      for (const key of ['name', 'apiType', 'defaultUrl', 'modelsText']) el(key).value = message.draft[key];
      renderGroupContext();
      auxiliaryChosen = operation === 'editionPreset' && auxiliaryChosen;
      const desiredAuxiliary = auxiliaryChosen ? el('auxiliaryModel').value : message.draft.auxiliaryModel;
      el('searchModels').value = '';
      for (const id of ['noAuth', 'stateless', 'applyRecommendedSettings', 'overwriteRecommendedSettings']) {
        const checkbox = el(id); checkbox.checked = checkbox.defaultChecked;
      }
      hasPendingKey = message.hasPendingKey === true; count();
      el('auxiliaryModel').value = displayedModels?.some(m => m.id === desiredAuxiliary) ? desiredAuxiliary : '';
      baseline = form(); updateDirty();
      el('configPath').textContent = message.configPath;
      if (message.error) notice(message.error, 'error');
    }
  });
  for (const type of ['import', 'restore', 'diagnose', 'manage', 'openJson', 'reload', 'setKey', 'clearKey', 'new']) {
    el(type).addEventListener('click', () => { if (type === 'new') notice(''); send(type); });
  }
  // EDITION_PRESET_ACTION
  for (const type of ['export', 'validate', 'apply']) el(type).addEventListener('click', () => send(type, { form: form() }));
  el('refresh').addEventListener('click', () => send('refresh', { name: selected || null }));
  el('switchGroup').addEventListener('click', () => { if (!el('switchGroup').disabled) send('switchGroup', { dirty }); });
  el('format').addEventListener('click', () => send('format', { modelsText: el('modelsText').value }));
  el('modelsText').addEventListener('input', modelsChanged);
  el('discoverModels').addEventListener('click', () => {
    if (el('discoverModels').disabled) return;
    const { defaultUrl, apiType, modelsText, noAuth } = form();
    send('discoverModels', { form: { defaultUrl, apiType, modelsText, noAuth } });
  });
  el('syncUrl').addEventListener('click', () => {
    try {
      const models = JSON.parse(el('modelsText').value);
      const url = el('defaultUrl').value.trim();
      if (!Array.isArray(models) || !url) throw new Error(tr("先填写地址，并确保下方是模型数组。含注释时请先点“格式化”。", "Enter a URL and ensure the models field is an array. Format first if it contains comments."));
      setModels(models.map(model => ({ ...model, url })));
      notice(dirty ? tr("已更新表单中全部模型的 url，尚未写入本机配置。请核对后再保存。", "All model URLs updated in the draft, not saved. Review before saving.") : '');
    } catch { notice(tr("无法同步地址。请确认模型数组格式正确；含注释时请先点“格式化”。", "Unable to sync URLs. Check the model array format; format first if it contains comments."), 'error'); }
  });
  el('addModels').addEventListener('click', () => send('addModels', {
    modelsText: el('modelsText').value, ids: el('ids').value,
    contextWindow: el('contextWindow').value, maxOutputTokens: el('maxOutputTokens').value,
    toolCalling: el('toolCalling').checked, vision: el('vision').checked
  }));
  el('modelsText').addEventListener('keydown', event => {
    if (event.key === 'Tab' && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
      event.preventDefault(); const target = event.currentTarget;
      target.setRangeText('  ', target.selectionStart, target.selectionEnd, 'end'); modelsChanged();
    }
  });
  // Do not use setState/localStorage/clipboard for credentials or configuration.
  send('ready');
})();
