import json
from pathlib import Path

root=Path(__file__).resolve().parent
folder=root/'private-results'
audit=json.loads((folder/'structural-audit.json').read_text(encoding='utf-8'))
models=sorted(folder.glob('qwen-real-*.json'))
model=json.loads(models[-1].read_text(encoding='utf-8')) if models else None
sample=json.loads((folder/'real-sample.json').read_text(encoding='utf-8'))
records={r['id']:r for r in sample['records']}
lines=['# Проверка данных basw','',
'Исходные ARB не изменены. Отчёт содержит данные кейса и предназначен для локальной работы. Проверки структуры выполнены по всему основному набору; Qwen проверяет только 12 выбранных строк, а не весь корпус.', '',
'## Состав набора','', '| Файл | Уникальных строковых ключей | Повторяющихся ключей сообщений |','|---|---:|---:|']
for f in audit['inventory']:
    lines.append(f"| {f['file']} | {f['strings']} | {len(f['duplicate_message_keys'])} |")
lines += ['', 'Повторяющиеся @@comment сохранены для контекста. Для основного аудита используется последнее значение ключа; все варианты дубликатов записаны в structural-audit.json → inventory → duplicate_variants. Ранние варианты не прошли полную языковую проверку. Файлы PaxHeader и ._ — служебные, не локализации.', '',
'В test_sample есть 147 строковых ключей. errors_ru.md описывает фрагмент с 45 ключами и прямо называет оценку предварительной; это не официальный список ошибок. Два ключа выборки (bingo_title и bingo_description) отличаются от последних значений одноимённых ключей основного файла. Из-за дубликатов выборку нельзя молча приравнивать к разобранному основному ARB.', '',
'## Структурные находки и кандидаты','', '| Тип | kk | uz | en |','|---|---:|---:|---:|']
for t in ['untranslated','placeholder_mismatch','same_as_source','suffix_harmony','length_overflow']:
    lines.append('| '+t+' | '+' | '.join(str(audit['locales'][l]['counts'].get(t,0)) for l in ['kk','uz','en'])+' |')
lines += ['', 'Для kk untranslated: 12 отсутствующих ключей и 4 пустых значения. Совпадения с русским, окончания и длина — кандидаты, не подтверждённые языковые ошибки. Одной строке могут соответствовать несколько находок; числа нельзя трактовать как количество уникальных ошибочных строк или Recall на 100 подложенных ошибках.', '',
'ICU-конструкции plural/select в основном наборе не обнаружены по поиску шаблона. Полный ICU-парсер и flutter gen-l10n в этой проверке не использовались. Простые {name} и printf-подстановки проверены отдельно. Валидность JSON не доказывает совместимость с Flutter.', '',
'## Несовпадения подстановок kk','']
for finding in audit['locales']['kk']['findings']:
    if finding['issue_type']=='placeholder_mismatch': lines.append(f"- `{finding['key']}`: {finding['evidence']}")
if model:
    lines += ['', '## Ответы Qwen на диагностической выборке','',
    'Профиль и веса во время этого прогона не менялись. В модель переданы строки, имена ключей, разделы и связанные фрагменты, но не errors_ru.md. Выборка целевая, не случайная; precision/recall без полной разметки не считаются. Метки ниже — вывод модели, а не подтверждённые находки.', '',
    '| Ключ | Метки Qwen |', '|---|---|']
    for run in model['classification']:
        for r in run['output']['results']: lines.append(f"| {r['id']} | {', '.join(r['issues']) or 'Нет находок'} |")
    lines += ['', f"Завершено классификаций: {len(model['classification'])}/12; подробных запросов: {len(model['detailed'])}/3; ошибок запросов: {len(model['errors'])}.", '', '## Подробные предложения модели','']
    unsupported=[]
    for run in model['classification']:
        for r in run['output']['results']:
            if 'suffix_harmony' in r['issues'] and '{' not in records[r['id']]['target']:
                unsupported.append(r['id'])
    if unsupported:
        lines += [f"Диагностическая проблема: в {len(unsupported)} строках модель выбрала suffix_harmony, хотя перевод не содержит аргумента в фигурных скобках. Категория задания относится к окончанию после динамического значения; эти ответы не подтверждают такую ошибку. Даже наличие printf-подстановки требует доказать, что она содержит имя и к ней прикреплено окончание.", '', 'Ключи: '+', '.join(unsupported)+'.', '']
    for run in model['detailed']:
        for r in run['output']['results']:
            row=records[r['id']]
            lines += [f"### {r['id']}", '', f"Исходник: {row['source']}", '', f"Перевод: {row['target']}", '']
            if not r['issues']: lines += ['Модель не сообщила об ошибке.', '']
            for issue in r['issues']:
                lines += [f"- Тип: {issue['type']}",f"- Объяснение модели: {issue['evidence']}",f"- Предложение (не проверено человеком): {issue['suggestion']}",'']
    if model['errors']: lines += ['Ошибки запросов: '+json.dumps(model['errors'],ensure_ascii=False),'']
lines += ['## Что нужно для оценки качества','', 'Получить полную проверочную разметку или проверку носителем. Предварительные заметки не считать исчерпывающей разметкой. Глоссарий пока отсутствует. Сначала разобрать дубликаты и подтвердить значения ключей, затем формировать независимую выборку для настройки и сравнения профилей. Автоматические исправления и обучение на предложениях самой модели не выполнялись.','']
(folder/'REPORT.md').write_text('\n'.join(lines),encoding='utf-8')
print('Saved model-lab/private-results/REPORT.md')
