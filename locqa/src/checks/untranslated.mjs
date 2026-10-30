import {finding} from '../shared.mjs';
export default {id:'untranslated',run:ctx=>ctx.row.target===null||(!ctx.row.target.trim()&&ctx.row.source.trim())?[finding(ctx,'untranslated',ctx.row.target===null?'Строка отсутствует или имеет нестроковое значение.':'Перевод пуст при непустом исходнике.',{severity:'high',status:'structural'})]:[]};
