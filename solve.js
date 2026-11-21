// A faster drop-in for make.fun's csv-reader 1.0.0 (MIT, make.fun's own code).
//
// One left-to-right pass over the text. A record whose line holds no quote and no
// stray carriage return is taken whole and split on commas; anything else goes
// through a character-level reader that follows csv-reader's broken-row policy
// exactly: a U+FEFF at the very start is dropped, a record ends at LF or CRLF, a
// line left with no characters is no record, a CR outside quotes that is not
// followed by LF is dropped (stray_cr), a field that opens with a quote runs to
// the next quote that is not doubled ("" inside it is one quote, each CRLF or lone
// CR inside it reads as LF), what follows its closing quote up to the next comma
// or line break is appended as it stands (quote_junk, when the field ends), a
// quote that never closes is a literal character and the text after it is read
// again as unquoted (unterminated_quote), and a quote inside an unquoted field
// is a literal character. Fields stay strings. columns is the first record when
// header is true, else null; rows holds the records after it, each padded with
// "" (short_row) or cut (long_row) to the first record's width. Each error is
// {code, line, row}, in the order met.

const DQ = 34; // "
const CM = 44; // ,
const LF = 10; // \n
const CR = 13; // \r
const BOM = 0xfeff; // U+FEFF

/** csv-reader 1.0.0's answer for one case's input: {columns, rows, errors}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const rows = [];
  const errs = [];
  let cols = null;
  let width = -1;
  let p = 0; // the next character to read
  let ln = 1; // the line that character is on
  if (text.charCodeAt(0) === BOM) p = 1;

  // Takes a finished record: the header sets the width and the columns, any
  // other record is padded or cut to the width and joins the rows.
  const takeRecord = (fields, recordLine, recordRow) => {
    if (width < 0) width = fields.length;
    if (header && cols === null) { cols = fields; return; }
    if (fields.length < width) {
      errs.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errs.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.slice(width) });
      fields.length = width;
    }
    rows.push(fields);
  };

  // Reads unquoted characters onto `value` up to the next comma or line break:
  // a CR not followed by LF is dropped (stray_cr). Returns [value, ended,
  // added] where ended is 0 (comma), 1 (line break) or 2 (end of the text) and
  // added counts the characters kept.
  const readBare = (value, recordLine, recordRow) => {
    const before = value.length;
    let seg = p;
    let parts = null;
    let ended = 2;
    while (p < n) {
      const c = text.charCodeAt(p);
      if (c === CM) { ended = 0; break; }
      if (c === LF) { ended = 1; break; }
      if (c === CR) {
        if (text.charCodeAt(p + 1) === LF) { ended = 1; break; }
        errs.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        if (parts === null) parts = [text.slice(seg, p)];
        else parts.push(text.slice(seg, p));
        p += 1;
        seg = p;
        continue;
      }
      p += 1;
    }
    if (parts === null) value += text.slice(seg, p);
    else { parts.push(text.slice(seg, p)); value += parts.join(''); }
    if (ended === 0) p += 1;
    else if (ended === 1) {
      p += (text.charCodeAt(p) === CR) ? 2 : 1;
      ln += 1;
    }
    return [value, ended, value.length - before];
  };

  while (true) {
    // Lines with no characters are no records.
    while (p < n) {
      const c = text.charCodeAt(p);
      if (c === LF) { p += 1; ln += 1; }
      else if (c === CR && text.charCodeAt(p + 1) === LF) { p += 2; ln += 1; }
      else break;
    }
    if (p >= n) break;

    const recordLine = ln;
    const recordRow = (header && cols === null) ? null : rows.length;

    // Fast path: a whole line with no quote and no stray CR is split on commas.
    // The quote and CR checks run on the line itself, never past its end.
    const nl = text.indexOf('\n', p);
    const lineEnd = nl === -1 ? n : nl;
    let bodyEnd = lineEnd;
    if (nl !== -1 && bodyEnd > p && text.charCodeAt(bodyEnd - 1) === CR) bodyEnd -= 1;
    const line = text.slice(p, bodyEnd);
    if (line.indexOf('"') === -1 && line.indexOf('\r') === -1) {
      takeRecord(line.split(','), recordLine, recordRow);
      if (nl === -1) p = n;
      else { p = nl + 1; ln += 1; }
      continue;
    }

    // Slow path: the record holds a quote or a stray CR, so it is read field
    // by field.
    const fields = [];
    let lastQuoted = false;
    let ended = 0;
    do {
      lastQuoted = text.charCodeAt(p) === DQ;
      let value;
      if (lastQuoted) {
        // A field that opens with a quote.
        const openPos = p;
        const openLine = ln;
        p += 1;
        value = '';
        let closed = false;
        while (true) {
          const q = text.indexOf('"', p);
          if (q === -1) break; // the quote never closes
          const segStr = text.slice(p, q);
          if (segStr.indexOf('\r') === -1 && segStr.indexOf('\n') === -1) {
            if (text.charCodeAt(q + 1) === DQ) {
              value += segStr + '"';
              p = q + 2;
              continue;
            }
            value += segStr;
            p = q + 1;
            closed = true;
            break;
          }
          // The segment holds a CR or LF: walk it, turning each CRLF or lone
          // CR into one LF and counting lines.
          let s = p;
          for (let i = p; i < q; i++) {
            const c = text.charCodeAt(i);
            if (c === CR) {
              value += text.slice(s, i) + '\n';
              ln += 1;
              if (text.charCodeAt(i + 1) === LF) i += 1;
              s = i + 1;
            } else if (c === LF) {
              ln += 1;
            }
          }
          value += text.slice(s, q);
          if (text.charCodeAt(q + 1) === DQ) {
            value += '"';
            p = q + 2;
            continue;
          }
          p = q + 1;
          closed = true;
          break;
        }
        if (!closed) {
          // The quote never closes: it is a literal character, and the text
          // after it is read again as unquoted.
          p = openPos + 1;
          ln = openLine;
          errs.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
          [value, ended] = readBare('"', recordLine, recordRow);
        } else if (p >= n) {
          ended = 2;
        } else {
          const c = text.charCodeAt(p);
          if (c === CM) { p += 1; ended = 0; }
          else if (c === LF) { p += 1; ln += 1; ended = 1; }
          else if (c === CR && text.charCodeAt(p + 1) === LF) { p += 2; ln += 1; ended = 1; }
          else {
            // What follows the closing quote is appended as it stands.
            let added;
            [value, ended, added] = readBare(value, recordLine, recordRow);
            if (added > 0) errs.push({ code: 'quote_junk', line: recordLine, row: recordRow });
          }
        }
      } else {
        [value, ended] = readBare('', recordLine, recordRow);
      }
      fields.push(value);
    } while (ended === 0);

    // A line that held only stray CRs is left with no characters: no record.
    if (!(fields.length === 1 && fields[0] === '' && !lastQuoted)) {
      takeRecord(fields, recordLine, recordRow);
    }
  }

  return { columns: header ? (cols ?? []) : null, rows, errors: errs };
}
