(function (global) {
  'use strict';

  // -------------------------------------------------------------------
  // PuzParser
  //
  // Parses the classic Across Lite ".puz" binary crossword format into
  // the plain-object shape app.js expects:
  //
  //   {
  //     width, height,
  //     title, author, copyright, notes,
  //     solution,      // string, length width*height, '.' = black square
  //     cellNumber,    // array, length width*height, clue number or 0
  //     across, down,  // arrays of { num, dir, clue, cell, cells: [idx,...] }
  //     acrossAt, downAt, // arrays, length width*height, entry object or null
  //     sequence       // ordered list of every entry (across+down) in the
  //                    // order solving normally visits them, each with
  //                    // { cell, dir, ... } for tab/enter navigation
  //   }
  //
  // Reference: the (unofficial but well-documented) .puz format used by
  // Across Lite. See https://github.com/alexdej/puzpy and similar
  // projects for the layout this is based on.
  // -------------------------------------------------------------------

  var HEADER_OFFSET = 0x00;
  var CHECKSUM_OFFSET = 0x00;
  var MAGIC_OFFSET = 0x02;
  var MAGIC = 'ACROSS&DOWN\0';
  var FILE_CHECKSUM_LEN = 2;

  // Header layout starting at byte 0x00 (all little-endian):
  //   0x00  2   overall checksum
  //   0x02  12  magic "ACROSS&DOWN\0"
  //   0x0E  2   cib checksum
  //   0x10  8   masked low checksums
  //   0x18  8   masked high checksums
  //   0x20  4   version string, e.g. "1.3\0"
  //   0x24  2   reserved1 (unused, sometimes garbage)
  //   0x26  2   scrambled checksum
  //   0x28  12  reserved2
  //   0x34  1   width
  //   0x35  1   height
  //   0x36  2   number of clues
  //   0x38  2   unknown bitmask (puzzle type)
  //   0x3A  2   scrambled tag (0 = not scrambled)
  //   0x3C  ... solution (width*height bytes)
  //            grid (width*height bytes)
  //            strings: title\0 author\0 copyright\0 clue1\0 clue2\0 ... notes\0

  function PuzParseError(msg) {
    this.name = 'PuzParseError';
    this.message = msg;
  }
  PuzParseError.prototype = Object.create(Error.prototype);

  function parse(arrayBuffer) {
    var bytes = new Uint8Array(arrayBuffer);
    var view = new DataView(arrayBuffer);

    // Locate the magic string. Normally at 0x02, but some files carry
    // extra leading bytes, so scan defensively rather than assume.
    var magicOffset = findMagic(bytes);
    if (magicOffset === -1) {
      throw new PuzParseError('This doesn\u2019t look like a .puz file (missing ACROSS&DOWN signature).');
    }
    // Re-base everything relative to where the magic actually starts,
    // in case there is leading padding before the header.
    var base = magicOffset - MAGIC_OFFSET;

    var width = bytes[base + 0x34];
    var height = bytes[base + 0x35];
    var numClues = view.getUint16(base + 0x36, true);
    var scrambledTag = view.getUint16(base + 0x3A, true);

    if (!width || !height || width > 100 || height > 100) {
      throw new PuzParseError('Puzzle header looks corrupted (bad grid dimensions).');
    }

    var gridSize = width * height;
    var solutionStart = base + 0x34 + 8; // 0x3C
    var gridStart = solutionStart + gridSize;
    var stringsStart = gridStart + gridSize;

    var solutionBytes = bytes.subarray(solutionStart, solutionStart + gridSize);
    if (solutionBytes.length < gridSize) {
      throw new PuzParseError('Puzzle file is truncated (solution grid cut off).');
    }
    var solution = bytesToLatin1(solutionBytes);

    if (scrambledTag !== 0) {
      throw new PuzParseError('This puzzle is scrambled/locked and can\u2019t be opened here.');
    }

    // Pull the null-terminated string section: title, author, copyright,
    // then `numClues` clue strings in file order, then an optional notes
    // string.
    var strings = readNullTerminatedStrings(bytes, stringsStart, numClues + 4);
    var title = strings[0] || '';
    var author = strings[1] || '';
    var copyright = strings[2] || '';
    var clueTexts = strings.slice(3, 3 + numClues);
    var notes = strings[3 + numClues] || '';

    // Determine which cells start a numbered entry (across and/or down),
    // Across Lite numbering rules: a cell gets a number if it's not
    // black and (it starts an across entry OR it starts a down entry).
    var cellNumber = new Array(gridSize).fill(0);
    var acrossStarts = []; // { index }
    var downStarts = [];
    var num = 0;

    for (var r = 0; r < height; r++) {
      for (var c = 0; c < width; c++) {
        var idx = r * width + c;
        if (solution.charAt(idx) === '.') continue;

        var startsAcross = (c === 0 || solution.charAt(idx - 1) === '.') &&
          (c + 1 < width && solution.charAt(idx + 1) !== '.');
        var startsDown = (r === 0 || solution.charAt(idx - width) === '.') &&
          (r + 1 < height && solution.charAt(idx + width) !== '.');

        if (startsAcross || startsDown) {
          num++;
          cellNumber[idx] = num;
          if (startsAcross) acrossStarts.push(idx);
          if (startsDown) downStarts.push(idx);
        }
      }
    }

    if (acrossStarts.length + downStarts.length !== clueTexts.length) {
      // Not necessarily fatal for our purposes (some malformed files
      // pad clues), but worth surfacing rather than silently misaligning
      // clue text to entries.
      console.warn(
        '[puz-parser] clue count mismatch: grid implies ' +
        (acrossStarts.length + downStarts.length) + ' clues, file lists ' + clueTexts.length + '.'
      );
    }

    // Clues in a .puz file are stored in the order the numbered squares
    // appear, reading left-to-right/top-to-bottom, with across clues
    // before down clues whenever a cell starts both.
    var clueQueue = clueTexts.slice();
    var across = [];
    var down = [];
    var acrossAt = new Array(gridSize).fill(null);
    var downAt = new Array(gridSize).fill(null);

    for (var r2 = 0; r2 < height; r2++) {
      for (var c2 = 0; c2 < width; c2++) {
        var idx2 = r2 * width + c2;
        if (!cellNumber[idx2]) continue;

        var isAcrossStart = acrossStarts.indexOf(idx2) !== -1;
        var isDownStart = downStarts.indexOf(idx2) !== -1;

        if (isAcrossStart) {
          var acrossCells = collectEntryCells(solution, width, height, idx2, 'across');
          var acrossEntry = {
            num: cellNumber[idx2],
            dir: 'across',
            clue: clueQueue.shift() || '',
            cell: idx2,
            cells: acrossCells
          };
          across.push(acrossEntry);
          acrossCells.forEach(function (ci) { acrossAt[ci] = acrossEntry; });
        }
        if (isDownStart) {
          var downCells = collectEntryCells(solution, width, height, idx2, 'down');
          var downEntry = {
            num: cellNumber[idx2],
            dir: 'down',
            clue: clueQueue.shift() || '',
            cell: idx2,
            cells: downCells
          };
          down.push(downEntry);
          downCells.forEach(function (ci) { downAt[ci] = downEntry; });
        }
      }
    }

    // Build the natural tab/enter navigation order: every across entry
    // then every down entry, both already in grid (reading) order, then
    // merge by clue number so navigation alternates sensibly the way
    // solvers expect (all acrosses then all downs is the conventional
    // .puz solving order used by Across Lite / NYT-style apps).
    var sequence = across.concat(down);

    return {
      width: width,
      height: height,
      title: cleanString(title),
      author: cleanString(author),
      copyright: cleanString(copyright),
      notes: cleanString(notes),
      solution: solution,
      cellNumber: cellNumber,
      across: across,
      down: down,
      acrossAt: acrossAt,
      downAt: downAt,
      sequence: sequence
    };
  }

  function collectEntryCells(solution, width, height, startIdx, dir) {
    var cells = [];
    if (dir === 'across') {
      var r = Math.floor(startIdx / width);
      var c = startIdx % width;
      while (c < width && solution.charAt(r * width + c) !== '.') {
        cells.push(r * width + c);
        c++;
      }
    } else {
      var c2 = startIdx % width;
      var r2 = Math.floor(startIdx / width);
      while (r2 < height && solution.charAt(r2 * width + c2) !== '.') {
        cells.push(r2 * width + c2);
        r2++;
      }
    }
    return cells;
  }

  function findMagic(bytes) {
    var magicBytes = [];
    for (var i = 0; i < MAGIC.length; i++) magicBytes.push(MAGIC.charCodeAt(i));
    var limit = Math.min(bytes.length - magicBytes.length, 64); // magic should be near the start
    for (var offset = 0; offset <= limit; offset++) {
      var match = true;
      for (var j = 0; j < magicBytes.length; j++) {
        if (bytes[offset + j] !== magicBytes[j]) { match = false; break; }
      }
      if (match) return offset;
    }
    return -1;
  }

  // Reads up to `count` NUL-terminated strings starting at `offset`,
  // decoding each as Latin-1/CP1252-ish bytes (the .puz format doesn't
  // guarantee UTF-8; falling back to per-byte decoding keeps accented
  // characters from throwing, matching how most puz readers behave).
  function readNullTerminatedStrings(bytes, offset, count) {
    var result = [];
    var pos = offset;
    for (var i = 0; i < count; i++) {
      if (pos > bytes.length) { result.push(''); continue; }
      var start = pos;
      while (pos < bytes.length && bytes[pos] !== 0) pos++;
      result.push(bytesToLatin1(bytes.subarray(start, pos)));
      pos++; // skip the NUL terminator
    }
    return result;
  }

  function bytesToLatin1(byteArray) {
    var s = '';
    for (var i = 0; i < byteArray.length; i++) {
      s += String.fromCharCode(byteArray[i]);
    }
    // Most modern .puz files are actually UTF-8 flagged via a GEXT/other
    // extra section or just plain ASCII; attempt a UTF-8 re-decode when
    // it looks safe, otherwise keep the Latin-1 fallback.
    try {
      var decoded = decodeURIComponent(escape(s));
      return decoded;
    } catch (e) {
      return s;
    }
  }

  function cleanString(s) {
    return (s || '').replace(/\u0000+$/, '').trim();
  }

  global.PuzParser = {
    parse: parse,
    PuzParseError: PuzParseError
  };

})(typeof window !== 'undefined' ? window : this);
