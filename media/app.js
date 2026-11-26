'use strict';
(() => {
  const vscode = acquireVsCodeApi();
  const tr = (zh, en) => document.documentElement.lang.toLowerCase().startsWith('zh') ? zh : en;
  const el = id => document.getElementById(id);
  let busy = false;
  function send(type, rest = {}) { if (!busy) vscode.postMessage({ type, ...rest }); }
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
  function keyStatus(pending) {
    el('keyStatus').textContent = pending ? tr("已录入新密钥，待保存", "New key entered; pending save") : tr("未录入新密钥；保存时复用同名组密钥。", "No new key entered. Saving reuses the same group's local key.");
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
  function setModels(models) { el('modelsText').value = JSON.stringify(models, null, 2); count(); }
  function count() {
    const list = el('modelList'), problem = el('modelProblem'); list.replaceChildren();
    let models;
    try { models = readModels(); problem.hidden = true; }
    catch { el('modelCount').textContent = '—'; problem.hidden = false; problem.textContent = tr("无法解析模型列表，请在高级配置中修复 JSONC 或点击“格式化并解析”。", "Cannot parse models. Fix JSONC or select Format and Parse."); list.append(node('div','empty',tr("可视化列表暂不可用", "Visual model list unavailable"))); return; }
    const aux = el('auxiliaryModel'), previousAux = aux.value;
    aux.replaceChildren(new Option(tr("不修改模型选择器", "Keep existing model selectors"), ''));
    for (const m of models) if (typeof m.id === 'string' && m.id) aux.add(new Option(m.name || m.id, m.id));
    aux.value = models.some(m => m.id === previousAux) ? previousAux : '';
    el('modelCount').textContent = `${models.length}${tr(" 个模型", " models")}`;
    const query = el('searchModels').value.trim().toLowerCase();
    let visible = 0;
    if (models.length) { const head=node('div','model-heading'); for (const label of [tr("模型 / ID", "Model / ID"),tr("协议", "Protocol"),tr("上下文 / 输出", "Context / Output"),tr("能力 / 思考档位", "Capabilities / Effort"),tr("操作", "Actions")]) head.append(node('span','',label)); list.append(head); }
    models.forEach((model, i) => {
      if (query && !`${model.name || ''} ${model.id || ''}`.toLowerCase().includes(query)) return;
      visible++;
      const row = node('article','model-item'), body = node('div','model-body');
      body.append(node('div','model-name',model.name || model.id || tr("未命名模型", "Unnamed model")), node('div','model-id',model.id || tr("缺少 ID", "Missing ID")));
      const protocol = node('div','model-protocol', ({'chat-completions':'Chat Completions', responses:'Responses', messages:'Messages'})[model.apiType || el('apiType').value] || String(model.apiType || el('apiType').value));
      if (!model.apiType) protocol.append(node('div','model-id',tr("继承组协议", "Inherited protocol")));
      const meta = node('div','model-meta');
      meta.append(node('span','',number(model.contextWindow)),node('span','model-id',tr("输出 ", "Output ")+number(model.maxOutputTokens)));
      if (model.maxInputTokens !== undefined) meta.append(node('span','model-id',tr("输入 ", "Input ")+number(model.maxInputTokens)));
      const caps = node('div','model-cap');
      const supported = [['toolCalling',tr("工具", "Tools")],['vision',tr("视觉", "Vision")],['thinking',tr("思考", "Reasoning")]].filter(([key])=>model[key]===true).map(([,label])=>label);
      caps.append(node('div','',supported.join(' · ') || '—'));
      if (Array.isArray(model.supportsReasoningEffort) && model.supportsReasoningEffort.length) caps.append(node('div','model-id',model.supportsReasoningEffort.join(' / ')));
      const actions = node('div','model-actions');
      for (const [label, mode] of [[tr("编辑", "Edit"),'edit'],[tr("复制", "Copy"),'copy'],[tr("删除", "Delete"),'delete']]) {
        const b = node('button','row-action'+(mode==='delete'?' danger':''),label); b.type='button'; b.disabled = busy; b.setAttribute('aria-label',`${label} ${model.name || model.id || tr("模型", "Model")}`);
        b.addEventListener('click', () => { if (mode==='delete') { deleteIndex=i; el('deleteDescription').textContent=`${tr("确认移除 ", "Remove ")}${model.name || model.id || tr("该模型", "this model")}？`; el('deleteDialog').showModal(); } else openEditor(mode,i); }); actions.append(b);
      }
      row.append(body,protocol,meta,caps,actions); list.append(row);
    });
    if (!visible) { list.replaceChildren(); list.append(node('div','empty',models.length ? tr("没有匹配的模型", "No matching models") : tr("暂无模型", "No models"))); }
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
      setModels(models); el('searchModels').value=''; count(); el('modelDialog').close(); notice(tr("模型已修改，尚未保存。", "Model changed; not saved."));
    } catch(e) {fieldError('editorError',e.message);}
  });
  el('cancelDelete').addEventListener('click',()=>el('deleteDialog').close());
  el('deleteDialog').addEventListener('close',()=>{deleteIndex=null;});
  el('confirmDelete').addEventListener('click',()=>{if(deleteIndex===null||busy)return;const latest=readModels();latest.splice(deleteIndex,1);setModels(latest);el('deleteDialog').close();notice(tr("模型已移除，尚未保存。", "Model removed; not saved."));});
  el('searchModels').addEventListener('input',count);
  el('apiType').addEventListener('change',count);
  el('openMerge').addEventListener('click',()=>{try {readModels(); el('mergeText').value='';el('replaceDuplicates').checked=false;fieldError('mergeError','');el('mergeDialog').showModal();}catch{notice(tr("请先格式化或修复当前 JSONC。", "Format or fix the current JSONC first."),'error');}});
  for(const id of ['closeMerge','cancelMerge']) el(id).addEventListener('click',()=>{if(!busy)el('mergeDialog').close();});
  el('mergeDialog').addEventListener('cancel',e=>{if(busy)e.preventDefault();});
  el('mergeModels').addEventListener('click',()=>{if(busy)return;mergePending=true;fieldError('mergeError','');send('mergeModels',{form:form(),incomingText:el('mergeText').value,replace:el('replaceDuplicates').checked});});
  window.addEventListener('message', event => {
    const message = event.data;
    if (!message || typeof message.type !== 'string') return;
    if (message.type === 'busy') {
      busy = message.value === true;
      document.querySelectorAll('button, input, select, textarea').forEach(node => { node.disabled = busy; });
      el('apply').textContent = busy ? tr("正在处理…", "Working…") : tr("备份并写入", "Save with Backup");
      if (!busy) mergePending=false;
    } else if (message.type === 'notice') { notice(message.text, message.kind); if(mergePending && message.kind==='error') fieldError('mergeError',message.text); }
    else if (message.type === 'models') { el('modelsText').value = message.text; count(); }
    else if (message.type === 'merged') { el('modelsText').value=message.text; el('searchModels').value='';count();el('mergeDialog').close();mergePending=false; }
    else if (message.type === 'key') keyStatus(message.pending);
    else if (message.type === 'state') {
      const env = message.env;
      const ok = env.openJson && env.provider && env.trusted && env.desktop && !env.aiDisabled;
      el('environment').textContent = `VS Code ${env.version} · ` + (ok ? tr("Custom Endpoint 可用", "Custom Endpoint available") : tr("兼容性检查未通过，请查看环境诊断", "Compatibility check failed; see Diagnostics"));
      el('environment').className = 'environment' + (ok ? '' : ' warning');
      el('providers').replaceChildren(new Option(tr("新建模型组", "New model group"), ''));
      for (const group of message.groups) el('providers').add(new Option(`${group.name} · ${group.count}${tr(" 个模型", " models")}${group.hasKey ? tr(" · 有密钥引用", " · Key reference present") : ''}`, group.name));
      el('providers').value = message.selected || '';
      for (const key of ['name', 'apiType', 'defaultUrl', 'modelsText']) el(key).value = message.draft[key];
      el('auxiliaryModel').value=''; el('searchModels').value=''; el('noAuth').checked = false; keyStatus(message.hasPendingKey); count();
      el('configPath').textContent = message.configPath;
      if (message.error) notice(message.error, 'error');
    }
  });
  for (const type of ['import', 'restore', 'diagnose', 'manage', 'openJson', 'reload', 'setKey', 'clearKey', 'new']) {
    el(type).addEventListener('click', () => { if (type === 'new') notice(''); send(type); });
  }
  for (const type of ['export', 'validate', 'apply']) el(type).addEventListener('click', () => send(type, { form: form() }));
  el('refresh').addEventListener('click', () => { notice(''); send('refresh', { name: el('providers').value || null }); });
  el('providers').addEventListener('change', () => { notice(''); send(el('providers').value ? 'refresh' : 'new', { name: el('providers').value }); });
  el('format').addEventListener('click', () => send('format', { modelsText: el('modelsText').value }));
  el('modelsText').addEventListener('input', count);
  el('syncUrl').addEventListener('click', () => {
    try {
      const models = JSON.parse(el('modelsText').value);
      const url = el('defaultUrl').value.trim();
      if (!Array.isArray(models) || !url) throw new Error(tr("先填写地址，并确保下方是模型数组。含注释时请先点“格式化”。", "Enter a URL and ensure the models field is an array. Format first if it contains comments."));
      el('modelsText').value = JSON.stringify(models.map(model => ({ ...model, url })), null, 2);
      notice(tr("已更新表单中全部模型的 url，尚未写入本机配置。请核对后再保存。", "All model URLs updated in the draft, not saved. Review before saving.")); count();
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
      target.setRangeText('  ', target.selectionStart, target.selectionEnd, 'end');
    }
  });
  // Do not use setState/localStorage/clipboard for credentials or configuration.
  vscode.postMessage({ type: 'ready' });
})();
