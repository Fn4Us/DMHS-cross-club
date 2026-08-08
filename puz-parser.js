(function (global) {
  'use strict';

  // =========================================================================
  // PuzParser
  //
  // Parses the Across Lite ".puz" binary crossword format and turns it into
  // the plain-object shape app.js expects:
  //
  //   {
  //     title, author, notes,
  //     width, height,
  //     solution,              // string, length width*height, '.' = black
  //     cellNumber,            // array, cellNumber[i] = clue number or 0
  //     across, down,          // arrays of entries, in grid order
  //     acrossAt, downAt,      // arrays indexed by cell -> entry (or undefined)
  //     sequence               // all entries in natural tab/next-clue order
  //   }
  //
  // where an "entry" looks like:
  //   { num, dir: 'across'|'down', clue, cells: [idx, idx, ...], cell: idx }
  //
  // Reference for the file layout: the well-documented (if unofficial)
  // Across Lite .puz format. We only implement what's needed to *solve* a
  // standard puzzle -- we don't support scrambled/locked solutions or rebus
  // squares (GRBS/RTBL extra sections), and we ignore the saved fill state
  // stored in the file since every session starts from a blank grid.
  //
  //   0x00  2   overall file checksum
  //   0x02  12  magic "ACROSS&DOWN\0"
  //   0x0E  2   CIB checksum
  //   0x10  4   masked low checksums
  //   0x14  4   masked high checksums
  //   0x18  4   version string, e.g. "1.3\0"
  //   0x1C  2   reserved1c
  //   0x1E  2   scrambled checksum
  //   0x20  12  reserved20
  //   0x2C  1   width
  //   0x2D  1   height
  //   0x2E  2   number of clues
  //   0x30  2   unknown bitmask (puzzle type)
  //   0x32  2   scrambled tag (0 = not scrambled)
  //   0x34  ... solution (width*height bytes)
  //             saved fill state (width*height bytes) -- ignored
  //             strings: title\0 author\0 copyright\0 clue1\0 ... notes\0
  // =========================================================================

  var HEADER_LEN = 0x34; // 52 bytes before the solution grid begins

  function parse(arrayBuffer) {
    var bytes = new Uint8Array(arrayBuffer);
    var view = new DataView(arrayBuffer);

    if (bytes.length < HEADER_LEN + 2) {
      throw new Error('File is too small to be a .puz crossword.');
    }

    // ---- Magic string, offset 0x02, 11 bytes + NUL -----------------------
    var magic = decodeAscii(bytes, 0x02, 0x0D);
    if (magic !== 'ACROSS&DOWN') {
      throw new Error('This doesn\u2019t look like a .puz crossword file.');
    }

    // ---- Common Info Block, offset 0x2C, 8 bytes --------------------------
    var width = view.getUint8(0x2C);
    var height = view.getUint8(0x2D);
    var numClues = view.getUint16(0x2E, true);
    var scrambledTag = view.getUint16(0x32, true);

    if (!width || !height) {
      throw new Error('Puzzle grid dimensions are missing or invalid.');
    }
    if (scrambledTag !== 0) {
      throw new Error('This puzzle\u2019s solution is locked/scrambled and can\u2019t be loaded here.');
    }

    var cellCount = width * height;
    var gridBytesNeeded = HEADER_LEN + cellCount * 2; // solution + fill state
    if (bytes.length < gridBytesNeeded) {
      throw new Error('Puzzle file is truncated \u2014 the grid data is incomplete.');
    }

    // ---- Solution + (ignored) saved fill state -----------------------------
    var solution = readGridString(bytes, HEADER_LEN, cellCount).toUpperCase();
    var cursor = HEADER_LEN + cellCount; // skip solution
    cursor += cellCount;                 // skip saved player-state grid

    if (solution.length !== cellCount) {
      throw new Error('Puzzle solution data doesn\u2019t match the grid size.');
    }

    // ---- Strings section: title, author, copyright, clues..., notes -------
    var titleRes = readCString(bytes, cursor); cursor = titleRes.next;
    var authorRes = readCString(bytes, cursor); cursor = authorRes.next;
    var copyrightRes = readCString(bytes, cursor); cursor = copyrightRes.next;

    var clues = [];
    for (var i = 0; i < numClues; i++) {
      if (cursor > bytes.length) {
        throw new Error('Puzzle file is missing clue text \u2014 it may be corrupted.');
      }
      var clueRes = readCString(bytes, cursor);
      clues.push(clueRes.value);
      cursor = clueRes.next;
    }

    var notes = '';
    if (cursor <= bytes.length) {
      notes = readCString(bytes, cursor).value;
    }

    // ---- Build the grid layout: numbering, across/down entries ------------
    var built = buildEntries(solution, width, height, clues);

    return {
      title: titleRes.value,
      author: authorRes.value,
      notes: notes,
      width: width,
      height: height,
      solution: solution,
      cellNumber: built.cellNumber,
      across: built.across,
      down: built.down,
      acrossAt: built.acrossAt,
      downAt: built.downAt,
      sequence: built.sequence
    };
  }

  // -------------------------------------------------------------------------
  // Grid numbering + across/down entry construction.
  //
  // Standard crossword numbering: scan the grid left-to-right, top-to-bottom.
  // A cell starts a new number if it's white and either:
  //   - it begins an across entry (nothing to its left, something to its
  //     right), and/or
  //   - it begins a down entry (nothing above it, something below it)
  // Clue text is consumed from the flat `clues` array in the same order:
  // for each numbered cell, across (if it starts one) is taken before down.
  // -------------------------------------------------------------------------
  function buildEntries(solution, width, height, clues) {
    var cellNumber = new Array(solution.length);
    for (var z = 0; z < cellNumber.length; z++) cellNumber[z] = 0;

    var across = [];
    var down = [];
    var acrossAt = new Array(solution.length);
    var downAt = new Array(solution.length);
    var sequence = [];
    var num = 0;
    var clueIdx = 0;

    function isBlack(idx) { return solution.charAt(idx) === '.'; }

    for (var r = 0; r < height; r++) {
      for (var c = 0; c < width; c++) {
        var idx = r * width + c;
        if (isBlack(idx)) continue;

        var startsAcross = (c === 0 || isBlack(idx - 1)) &&
          (c < width - 1 && !isBlack(idx + 1));
        var startsDown = (r === 0 || isBlack(idx - width)) &&
          (r < height - 1 && !isBlack(idx + width));

        if (!startsAcross && !startsDown) continue;

        num++;
        cellNumber[idx] = num;

        if (startsAcross) {
          var acrossCells = [];
          var ac = idx;
          while (ac < solution.length && Math.floor(ac / width) === r && !isBlack(ac)) {
            acrossCells.push(ac);
            ac++;
          }
          if (clueIdx >= clues.length) {
            throw new Error('Puzzle file has fewer clues than the grid needs \u2014 it may be corrupted.');
          }
          var acrossEntry = {
            num: num,
            dir: 'across',
            clue: clues[clueIdx++],
            cells: acrossCells,
            cell: idx
          };
          across.push(acrossEntry);
          sequence.push(acrossEntry);
          for (var ai = 0; ai < acrossCells.length; ai++) acrossAt[acrossCells[ai]] = acrossEntry;
        }

        if (startsDown) {
          var downCells = [];
          var dc = idx;
          while (dc < solution.length && !isBlack(dc)) {
            downCells.push(dc);
            dc += width;
          }
          if (clueIdx >= clues.length) {
            throw new Error('Puzzle file has fewer clues than the grid needs \u2014 it may be corrupted.');
          }
          var downEntry = {
            num: num,
            dir: 'down',
            clue: clues[clueIdx++],
            cells: downCells,
            cell: idx
          };
          down.push(downEntry);
          sequence.push(downEntry);
          for (var di = 0; di < downCells.length; di++) downAt[downCells[di]] = downEntry;
        }
      }
    }

    if (!sequence.length) {
      throw new Error('Couldn\u2019t find any across or down entries in this puzzle.');
    }

    return {
      cellNumber: cellNumber,
      across: across,
      down: down,
      acrossAt: acrossAt,
      downAt: downAt,
      sequence: sequence
    };
  }

  // -------------------------------------------------------------------------
  // Byte helpers
  // -------------------------------------------------------------------------

  // Grid bytes (solution / fill-state strings) are always plain ASCII
  // ('.', '-', A-Z, occasional rebus punctuation) -- one byte per cell,
  // so a straight char-code read is safe regardless of the file's text
  // encoding.
  function readGridString(bytes, start, length) {
    var out = '';
    for (var i = 0; i < length; i++) out += String.fromCharCode(bytes[start + i]);
    return out;
  }

  function decodeAscii(bytes, start, end) {
    var out = '';
    for (var i = start; i < end && bytes[i] !== 0; i++) out += String.fromCharCode(bytes[i]);
    return out;
  }

  // Title/author/clue/notes text can contain accented characters. Puzzle
  // files in the wild are inconsistently encoded (older ones are
  // Windows-1252 / Latin-1, newer export tools often use UTF-8), so try
  // UTF-8 first and fall back to Windows-1252 if that produced
  // replacement-character mangling.
  function decodeText(bytes, start, end) {
    var slice = bytes.subarray(start, end);
    if (typeof TextDecoder === 'undefined') {
      return decodeAscii(bytes, start, end);
    }
    var utf8 = new TextDecoder('utf-8').decode(slice);
    if (utf8.indexOf('\uFFFD') === -1) return utf8;
    try {
      return new TextDecoder('windows-1252').decode(slice);
    } catch (e) {
      return utf8;
    }
  }

  // Reads one NUL-terminated string starting at `offset`.
  // Returns { value, next } where `next` is the offset just past the NUL.
  function readCString(bytes, offset) {
    var end = offset;
    while (end < bytes.length && bytes[end] !== 0) end++;
    var value = decodeText(bytes, offset, end);
    return { value: value, next: end + 1 };
  }

  global.PuzParser = { parse: parse };
})(typeof window !== 'undefined' ? window : this);
