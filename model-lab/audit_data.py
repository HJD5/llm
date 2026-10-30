"""Read-only structural audit. Local reports contain private source data."""
import json, re, hashlib
from pathlib import Path
from collections import Counter

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / 'basw/handout'
OUT = ROOT / 'model-lab/private-results'

class Obj(dict):
    def __init__(self, pairs):
        super().__init__(pairs)
        self.pairs = pairs
        self.duplicates = [k for k, n in Counter(k for k, v in pairs).items() if n > 1]

def read_arb(file):
    raw = file.read_text(encoding='utf-8-sig')
    obj = json.loads(raw, object_pairs_hook=Obj)
    if not isinstance(obj, Obj):
        raise ValueError('ARB root must be an object')
    strings = {k:v for k,v in obj.items() if not k.startswith('@') and isinstance(v,str)}
    section, contexts = '', {}
    for k,v in obj.pairs:
        if k == '@@comment': section = v
        elif k in strings:
            meta = obj.get('@'+k, {})
            contexts[k] = {'section': section, 'description': meta.get('description','') if isinstance(meta,dict) else ''}
    return strings, contexts, {'file':str(file.relative_to(ROOT)), 'sha256':hashlib.sha256(file.read_bytes()).hexdigest(),'strings':len(strings),'duplicate_metadata': [x for x in obj.duplicates if x.startswith('@')], 'duplicate_message_keys':[x for x in obj.duplicates if not x.startswith('@')], 'duplicate_variants':{k:[v for key,v in obj.pairs if key==k] for k in obj.duplicates if not k.startswith('@')}, 'value_policy':'last occurrence for primary audit; all duplicate message values retained in duplicate_variants for separate review', 'non_string_keys':[k for k,v in obj.items() if not k.startswith('@') and not isinstance(v,str)],'icu_candidates':sum(bool(re.search(r'\{[^{}]+,\s*(?:plural|select|selectordinal)\s*,',v)) for v in strings.values())}

def placeholders(value):
    # Simple arguments and printf substitutions only; not an ICU parser.
    braces = set(re.findall(r'\{\s*([A-Za-z_][A-Za-z_0-9]*)\s*\}',value))
    printf = Counter(re.findall(r'%(?:\d+\$)?[-+0 #]*(?:\d+)?(?:\.\d+)?[sdif]',value.replace('%%','')))
    return sorted(braces),dict(printf)

def audit(source,target):
    findings=[]
    for k,s in source.items():
        if k == 'lang': continue
        t=target.get(k)
        def add(kind,evidence,status='candidate'):
            findings.append({'key':k,'issue_type':kind,'source':s,'target':t,'evidence':evidence,'status':status,'reviewed_by_human':False})
        if t is None or (not t.strip() and s.strip()):
            add('untranslated','Ключ отсутствует или перевод пуст при непустом исходнике.','structural');continue
        if placeholders(s)!=placeholders(t):
            add('placeholder_mismatch',f'Подстановки: source={placeholders(s)}, target={placeholders(t)}','structural')
        if s==t and re.search('[А-Яа-яЁё]',s) and k!='currencySymbol':
            add('same_as_source','Точное совпадение с русским; проверить имена, бренды, заимствования и допустимый сленг.')
        if re.search(r'\{[^{}]+\}[-–]?(?:ға|ге|қа|ке|ның|нің|дың|дің|тың|тің|ны|ні|ды|ді|ты|ті|мен|бен|пен)(?![А-Яа-яӘәҒғҚқҢңӨөҰұҮүҺһІі])',t):
            add('suffix_harmony','Фиксированное окончание после аргумента; нужно проверить тип и возможные значения аргумента.')
        if re.search(r'button|btn|title|tab|header',k,re.I) and 2<=len(s)<=35 and len(t)>max(len(s)*1.8,len(s)+10):
            add('length_overflow',f'Кандидат короткого UI: {len(t)} символов вместо {len(s)}. Размеры интерфейса неизвестны; обрезание не подтверждено.')
    return findings

def main():
    OUT.mkdir(exist_ok=True)
    source,source_context,ruinfo=read_arb(DATA/'intl_ru.arb')
    inventory=[ruinfo]; reports={}
    for locale in ['kk','uz','en']:
        target,context,info=read_arb(DATA/f'intl_{locale}.arb')
        info.update(missing_keys=sorted(source.keys()-target.keys()),extra_keys=sorted(target.keys()-source.keys()))
        inventory.append(info)
        findings=audit(source,target)
        if locale!='kk': findings=[f for f in findings if f['issue_type']!='suffix_harmony']
        reports[locale]={'counts':dict(Counter(f['issue_type'] for f in findings)),'findings':findings}
    sample,_,sampleinfo=read_arb(DATA/'test_sample/intl_kk_test.arb')
    kk,kk_context,_=read_arb(DATA/'intl_kk.arb')
    sampleinfo['different_from_main']=[k for k,v in sample.items() if kk.get(k)!=v]
    inventory.append(sampleinfo)
    # Fixed diagnostic selection; not a representative or gold-labeled benchmark.
    focus=['drag_next_races_after','rosticsAcceptWorkDesc','rosticsAcceptWorkDesc1','rosticsAcceptWorkDesc3','rosticsGameWork1HeaderInfo1','rosticsGameBasketName0','bingo_goal_number','rosticsGameMistakes','rosticsGameOrderProductName0','rosticsGameOrderProductName1','rosticsGameOrderProductName5','rosticsGameBasketName2']
    records=[]
    for k in focus:
        if k not in sample or k not in source: continue
        related=[]
        if k.startswith('rosticsAcceptWorkDesc'):
            related=[{'key':x,'ru':source.get(x),'kk':sample.get(x)} for x in focus if x.startswith('rosticsAcceptWorkDesc')]
        records.append({'id':k,'source':source[k],'target':sample[k],'context':json.dumps({'source_metadata':source_context.get(k),'target_metadata':kk_context.get(k),'related_fragments':related},ensure_ascii=False)})
    input_data={'glossary':[],'records':records}
    (OUT/'real-sample.json').write_text(json.dumps(input_data,ensure_ascii=False,indent=2),encoding='utf-8')
    summary={'inventory':inventory,'checks':'JSON validity, message keys, simple brace/printf placeholders; same-as-source and length/suffix candidates. No semantic or full ICU validation. Metadata duplicate markers preserved for context.','locales':reports,'sample_size':len(records)}
    (OUT/'structural-audit.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({'inventory':[{k:v for k,v in x.items() if k!='duplicate_variants'} for x in inventory],'counts':{l:r['counts'] for l,r in reports.items()},'sample_size':len(records)},ensure_ascii=True,indent=2))

if __name__=='__main__':main()
