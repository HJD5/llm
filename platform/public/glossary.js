const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const labels={proposed:'Ожидает решения',approved:'Одобрено человеком',rejected:'Отклонено',keep:'Сохранить перевод',change:'Предложена замена',uncertain:'Qwen не уверен',unsuitable:'Проверить пригодность',pending:'Ожидает Qwen',reviewed:'Qwen ответил',rules:'Проверено кодом',failed:'Сбой Qwen',deferred:'Отложено',high:'Высокий',medium:'Средний',normal:'Обычный'};
export async function mountGlossary(root,{api,toast,datasetId,datasetName}){
  let data,query='',filter='proposed',priority='',queue='',page=0,reviewer='',note='',confirmed=false;
  const selected=new Set(),edits=new Map(),scopes=new Map(),size=20;
  const h=escape;
  function rows(){return data.entries.filter(r=>(!filter||r.status===filter)&&(!priority||r.priority===priority)&&(!queue||r.shortlist?.group===queue)&&(!query||[r.original.ru,r.original.kk,r.original.en,r.original.category,r.original.related_keys,r.original.comment,r.recommended_kk].some(v=>String(v??'').toLocaleLowerCase().includes(query.toLocaleLowerCase())))).sort((a,b)=>a.shortlist&&b.shortlist?a.shortlist.rank-b.shortlist.rank:({high:0,medium:1,normal:2}[a.priority]-{high:0,medium:1,normal:2}[b.priority]));}
  const translation=r=>edits.get(r.id)??r.decision?.translation??r.recommended_kk??r.original.kk;
  const scopeKey=r=>scopes.get(r.id)??r.decision?.key??r.original.key??'';
  function scopeControl(r){
    const keys=r.scope_keys??[...new Set([r.original.key,...String(r.original.related_keys??'').split('|'),...r.contexts.map(c=>c.key)].filter(Boolean))];
    if(r.original.key)return `<p class="history-meta">Ключ: ${h(r.original.key)}</p>`;
    return `<label class="history-meta">Область решения<select data-gl-scope="${h(r.id)}" aria-label="Ключ для ${h(r.original.ru)}"><option value="">${r.requires_key_scope?'Выберите один ключ':'Все контексты'}</option>${keys.map(key=>`<option value="${h(key)}" ${scopeKey(r)===key?'selected':''}>${h(key)}</option>`).join('')}</select></label>${r.requires_key_scope?'<p class="history-meta">Контексты различаются. Одобрение действует только для выбранного ключа.</p>':''}`;
  }
  function renderShortlistNotes(visible){
    const names={empty_kk:'Нет исходного KK',requires_key_scope:'Нужно выбрать ключ',conflicting_translations:'Несколько вариантов',not_llm_reviewed:'Без LLM-проверки',model_uncertain:'Qwen не уверена',model_change:'Есть предложение замены',existing_formatting:'Проверить форматирование',existing_line_break:'Перенос строки в KK',additional_arb_context:'Дополнительный ARB-контекст',arb_key_no_longer_matches:'Ключи ARB изменились',inflected_source_form:'Проверить словоформу'};
    for(const r of visible){
      if(!r.shortlist)continue;
      const value=r.shortlist,cell=root.querySelector(`[data-gl-edit="${CSS.escape(r.id)}"]`).closest('tr').children[1];
      cell.insertAdjacentHTML('beforeend',`<p class="history-meta"><b>#${h(value.rank)} · ${value.usage} ARB-ключей</b> · ${h(value.domain)}</p><span class="tag ${value.group==='needs_attention'?'amber':'teal'}">${value.group==='needs_attention'?'Нужен разбор':'Существующий KK без выявленных флагов'}</span><p class="history-meta">${h(value.comment)}</p><p class="history-meta">${h(value.flags.map(flag=>names[flag]??flag).join(' · '))}</p><details><summary>Комментарии и текущий ARB-контекст</summary><p>${h(r.original.comment)}</p>${value.contexts.map(c=>`<p><b>${h(c.key)}</b><br>RU: ${h(c.ru)}<br>KK: ${h(c.kk)}<br>EN: ${h(c.en)}<br>${h(c.section)} · ${h(c.description)}</p>`).join('')}</details>`);
    }
  }
  function renderTable(){
    const found=rows(),visible=found.slice(page*size,(page+1)*size);
    root.querySelector('#gl-table').innerHTML=`<div class="table-wrap"><table class="glossary-table"><thead><tr><th><input type="checkbox" id="gl-select-page" aria-label="Выбрать страницу" ${visible.length&&visible.every(r=>selected.has(r.id))?'checked':''}></th><th>RU / EN / контекст</th><th>Исходный KK</th><th>KK для подтверждения</th><th>Объяснение и приоритет</th></tr></thead><tbody>${visible.map(r=>`<tr><td><input type="checkbox" data-gl-select="${h(r.id)}" aria-label="Выбрать ${h(r.original.ru)}" ${selected.has(r.id)?'checked':''}></td><td><b>${h(r.original.ru)}</b><div class="history-meta">${h(r.original.en)}</div><details><summary>Контекст и метаданные</summary><p>${h(r.original.category)}</p><p>Варианты: ${h(r.original.observed_variants)}</p><p>Ключи: ${h(r.original.related_keys||r.original.key)}</p>${r.contexts.map(c=>`<p><b>${h(c.key)}</b><br>RU: ${h(c.ru)}<br>KK: ${h(c.kk)}<br>EN: ${h(c.en)}<br>${h(c.section)} · ${h(c.description)}</p>`).join('')}<pre>${h(JSON.stringify(r.original,null,2))}</pre></details></td><td>${h(r.original.kk)||'—'}</td><td><textarea data-gl-edit="${h(r.id)}" aria-label="Перевод ${h(r.original.ru)} для подтверждения" maxlength="1000" rows="2">${h(translation(r))}</textarea>${scopeControl(r)}<span class="tag ${r.status==='approved'?'teal':r.status==='rejected'?'red':''}">${h(labels[r.status])}</span>${r.decision?`<p class="history-meta">${h(r.decision.reviewer)} · ${h(r.decision.at)}<br>${h(r.decision.note)}</p>`:''}</td><td><span class="tag ${r.priority==='high'?'amber':''}">${h(labels[r.priority])}</span> <span class="tag">${h(labels[r.review_state])}</span><p><b>${h(labels[r.verdict])}</b><br>${h(r.explanation)}</p><small>${h([...r.flags,...(r.validation_flags??[])].join(', '))}</small></td></tr>`).join('')||'<tr><td colspan="5" class="empty">Терминов с такими фильтрами нет.</td></tr>'}</tbody></table></div><div class="gl-pagination"><button class="btn small" data-gl-action="prev" ${page===0?'disabled':''}>←</button><span>${found.length? page*size+1:0}–${Math.min((page+1)*size,found.length)} из ${found.length}</span><button class="btn small" data-gl-action="next" ${(page+1)*size>=found.length?'disabled':''}>→</button><span id="gl-selected">Выбрано: ${selected.size}</span></div>`;
    renderShortlistNotes(visible);
  }
  function render(){
    root.innerHTML=`<section class="panel gl-controls"><div class="panel-head"><h2>Глоссарий: решения человека</h2><a class="btn small" href="/api/glossary/export" download="glossary.csv">Экспорт glossary.csv (${data.counts.approved})</a></div><p class="card-note">Импортируйте CSV команды review-glossary. Qwen предлагает варианты; только ваше явное решение делает термин approved. Имя проверяющего вводится вами и не подтверждает квалификацию носителя языка.</p><div class="gl-tools"><label class="btn small">Импорт review CSV<input id="gl-import" type="file" accept=".csv" hidden></label><button class="btn small" data-gl-action="reload">Обновить</button><span>${data.entries.length} терминов · ожидают ${data.counts.proposed} · одобрено ${data.counts.approved} · отклонено ${data.counts.rejected}</span></div><div class="gl-tools"><input id="gl-query" class="filter" placeholder="Поиск RU, KK, EN, ключа" aria-label="Поиск терминов"><select id="gl-filter" class="filter" aria-label="Статус решения">${[['proposed','Ожидают решения'],['approved','Одобрены'],['rejected','Отклонены'],['','Все статусы']].map(([v,l])=>`<option value="${v}" ${filter===v?'selected':''}>${l}</option>`).join('')}</select><select id="gl-priority" class="filter" aria-label="Приоритет"><option value="">Все приоритеты</option>${['high','medium','normal'].map(v=>`<option value="${v}" ${priority===v?'selected':''}>${labels[v]}</option>`).join('')}</select></div></section><section class="panel results-panel" id="gl-table"></section><section class="panel gl-controls"><div class="gl-tools"><label>Имя проверяющего <input id="gl-reviewer" maxlength="100" value="${h(reviewer)}"></label><label>Комментарий <input id="gl-note" maxlength="2000" value="${h(note)}"></label></div><label class="gl-confirm"><input type="checkbox" id="gl-confirm" ${confirmed?'checked':''}>Я просмотрел(а) выбранные строки и подтверждаю решение по показанным переводам.</label><div class="gl-tools"><button class="btn primary" data-gl-action="approve">Одобрить выбранные</button><button class="btn danger" data-gl-action="reject">Отклонить выбранные</button><button class="btn" data-gl-action="reset">Вернуть в ожидание</button><button class="btn ghost" data-gl-action="clear">Снять выделение</button></div><p class="card-note">Можно изменить перевод перед одобрением. Экспорт содержит только явно одобренные человеком термины; observed_variants не становятся разрешёнными вариантами автоматически. После экспорта загрузите glossary.csv вместе с ARB в новый набор для проверки.</p></section>`;
    root.querySelector('#gl-query').value=query;
    if(datasetId){const section=document.createElement('section');section.className='panel gl-controls';section.innerHTML=`<h3>Исправленный ARB · ${h(datasetName??datasetId)}</h3><p class="card-note">В файл попадут только изменения по одобренным терминам и проверенным ключам. Предложения Qwen и непроверенные контексты не применяются. Набор выбирается на странице обзора.</p><button class="btn" data-gl-action="fixed-plan">Показать объём изменений</button> <button class="btn primary" data-gl-action="fixed-export">Скачать intl_kk_fixed.arb</button><p id="gl-fixed-summary" class="card-note"></p>`;root.append(section);}
    if(data.entries.some(r=>r.shortlist)){
      const control=document.createElement('select');control.id='gl-queue';control.className='filter';control.setAttribute('aria-label','Группа shortlist');
      control.innerHTML=`<option value="">Весь shortlist</option><option value="existing_translation">Существующий KK без флагов (${data.entries.filter(r=>r.shortlist?.group==='existing_translation').length})</option><option value="needs_attention">Нужен разбор (${data.entries.filter(r=>r.shortlist?.group==='needs_attention').length})</option>`;
      control.value=queue;root.querySelector('#gl-priority').after(control);
    }
    renderTable();
  }
  async function load(){data=await api('/api/glossary');queue=data.entries.some(r=>r.shortlist)?'existing_translation':'';selected.clear();edits.clear();scopes.clear();confirmed=false;render();}
  root.addEventListener('input',event=>{
    const t=event.target;
    if(t.dataset.glEdit){edits.set(t.dataset.glEdit,t.value);confirmed=false;root.querySelector('#gl-confirm').checked=false;}
    if(t.id==='gl-reviewer')reviewer=t.value;
    if(t.id==='gl-note')note=t.value;
    if(t.id==='gl-query'){query=t.value;page=0;renderTable();}
  });
  root.addEventListener('change',async event=>{
    const t=event.target;
    try{
      if(t.id==='gl-filter'||t.id==='gl-priority'){filter=root.querySelector('#gl-filter').value;priority=root.querySelector('#gl-priority').value;page=0;renderTable();}
      if(t.id==='gl-queue'){queue=t.value;page=0;selected.clear();confirmed=false;root.querySelector('#gl-confirm').checked=false;renderTable();}
      if(t.id==='gl-confirm')confirmed=t.checked;
      if(t.dataset.glScope){scopes.set(t.dataset.glScope,t.value);confirmed=false;root.querySelector('#gl-confirm').checked=false;}
      if(t.dataset.glSelect){t.checked?selected.add(t.dataset.glSelect):selected.delete(t.dataset.glSelect);renderTable();}
      if(t.id==='gl-select-page'){for(const r of rows().slice(page*size,(page+1)*size))t.checked?selected.add(r.id):selected.delete(r.id);renderTable();}
      if(t.id==='gl-import'&&t.files[0]){
        if(t.files[0].size>10*1024*1024)throw Error('Максимум 10 МБ');
        data=await api('/api/glossary/import',{csv:await t.files[0].text(),revision:data.revision});queue=data.entries.some(r=>r.shortlist)?'existing_translation':'';selected.clear();edits.clear();scopes.clear();confirmed=false;page=0;render();toast('Рекомендации загружены. Совпадающие решения человека сохранены.'+(data.previous_import_archive?' Предыдущий список сохранён в архиве.':''));
      }
    }catch(e){toast(e.message);}
  });
  root.addEventListener('click',async event=>{
    const b=event.target.closest('[data-gl-action]');if(!b)return;
    const action=b.dataset.glAction;
    try{
      if(action==='prev'||action==='next'){page+=action==='next'?1:-1;renderTable();return;}
      if(action==='reload'){await load();return;}
      if(action==='clear'){selected.clear();renderTable();return;}
      if(action==='fixed-plan'){
        const plan=await api('/api/glossary/fixed-plan?datasetId='+encodeURIComponent(datasetId));
        root.querySelector('#gl-fixed-summary').textContent=`Одобренных изменений: ${plan.approved_changes}. Непроверенных терминов: ${plan.pending_terms}. Заблокированных контекстов: ${plan.blocked.length}.`;return;
      }
      if(action==='fixed-export'){
        const response=await fetch('/api/glossary/fixed?datasetId='+encodeURIComponent(datasetId));if(!response.ok)throw Error((await response.json()).error);
        const url=URL.createObjectURL(await response.blob()),a=document.createElement('a');a.href=url;a.download='intl_kk_fixed.arb';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);return;
      }
      if(!selected.size||selected.size>100)throw Error('Выберите от 1 до 100 терминов');
      if(!confirmed||!reviewer.trim())throw Error('Укажите имя и поставьте отметку явного подтверждения');
      b.disabled=true;
      data=await api('/api/glossary/decisions',{revision:data.revision,entries:data.entries.filter(r=>selected.has(r.id)).map(r=>({id:r.id,translation:translation(r),key:scopeKey(r)})),status:action==='approve'?'approved':action==='reject'?'rejected':'proposed',reviewer,note,confirm:true});
      selected.clear();confirmed=false;page=0;render();toast('Решения сохранены. Экспорт включает только одобренные термины.');
    }catch(e){b.disabled=false;toast(e.message);}
  });
  try{await load();}catch(e){root.textContent='Не удалось загрузить глоссарий: '+e.message;}
}
