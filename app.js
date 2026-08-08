(function () {
  'use strict';

  // ---------------------------------------------------------------------
  // Which puzzle plays on this site. This is the ONLY line to change to
  // swap in a new week's puzzle — drop the new .puz file in /puzzles and
  // point this at it. Visitors never get to pick a different file.
  // ---------------------------------------------------------------------
  var PUZZLE_PATH = 'puzzles/newsletter-week-1-back-to-school.puz';

  var els = {};
  var puzzle = null;
  var state = null;

  document.addEventListener('DOMContentLoaded', init);

  function init() {
    cacheEls();
    wireStaticControls();

    fetch(PUZZLE_PATH)
      .then(function (res) {
        if (!res.ok) throw new Error('Could not load ' + PUZZLE_PATH + ' (' + res.status + ').');
        return res.arrayBuffer();
      })
      .then(function (buf) {
        puzzle = PuzParser.parse(buf);
        startGame();
      })
      .catch(function (err) {
        showLoadError(err);
      });
  }

  function cacheEls() {
    els.grid = document.getElementById('grid');
    els.gridWrap = document.getElementById('gridWrap');
    els.letterInput = document.getElementById('letterInput');
    els.acrossList = document.getElementById('acrossList');
    els.downList = document.getElementById('downList');
    els.currentClueText = document.getElementById('currentClueText');
    els.prevClueBtn = document.getElementById('prevClueBtn');
    els.nextClueBtn = document.getElementById('nextClueBtn');
    els.byline = document.getElementById('puzzleByline');
    els.notes = document.getElementById('puzzleNotes');
    els.timerDisplay = document.getElementById('timerDisplay');
    els.pauseBtn = document.getElementById('pauseBtn');
    els.pauseOverlay = document.getElementById('pauseOverlay');
    els.resumeBtn = document.getElementById('resumeBtn');
    els.pencilBtn = document.getElementById('pencilBtn');
    els.autocheckBtn = document.getElementById('autocheckBtn');
    els.resetBtn = document.getElementById('resetBtn');
    els.helpBtn = document.getElementById('helpBtn');
    els.helpModal = document.getElementById('helpModal');
    els.closeHelp = document.getElementById('closeHelp');
    els.solvedBanner = document.getElementById('solvedBanner');
    els.loadError = document.getElementById('loadError');
    els.appRoot = document.getElementById('appRoot');
    els.dropdowns = Array.prototype.slice.call(document.querySelectorAll('.dropdown'));

    // The hidden letter input sits exactly on top of the selected cell so
    // it can capture keystrokes. If it can receive pointer events, a
    // second click on the same square lands on the *input* instead of the
    // cell underneath, which silently swallows the click. Making it
    // click-through lets every click always reach the .cell element.
    els.letterInput.style.pointerEvents = 'none';
  }

  function showLoadError(err) {
    console.error(err);
    els.loadError.hidden = false;
    els.loadError.textContent = 'Couldn\u2019t load this week\u2019s puzzle. ' + (err && err.message ? err.message : '');
  }

  // -----------------------------------------------------------------------
  // Scroll helpers
  // -----------------------------------------------------------------------
  // Repositioning or focusing the hidden letter input can trigger some
  // browsers (notably Safari, which doesn't honor focus()'s preventScroll
  // option) to auto-scroll the page to keep it in view. That makes the
  // whole page jump around on click or arrow-key navigation. We snapshot
  // the scroll position and restore it immediately, and again on the next
  // frame in case the browser scrolls asynchronously.
  function preserveScroll(fn) {
    var x = window.scrollX, y = window.scrollY;
    fn();
    if (window.scrollX !== x || window.scrollY !== y) window.scrollTo(x, y);
    requestAnimationFrame(function () {
      if (window.scrollX !== x || window.scrollY !== y) window.scrollTo(x, y);
    });
  }

  // -----------------------------------------------------------------------
  // Game bootstrap
  // -----------------------------------------------------------------------
  function startGame() {
    state = {
      cells: puzzle.solution.split('').map(function (ch, idx) {
        return { index: idx, black: ch === '.', letter: '', pencil: false, revealed: false, wasWrong: false, isWrong: false };
      }),
      currentIndex: puzzle.sequence[0].cell,
      direction: puzzle.sequence[0].dir,
      pencilMode: false,
      autoCheck: false,
      solved: false,
      timer: { elapsed: 0, running: false, intervalId: null }
    };

    document.title = puzzle.title ? (puzzle.title + ' \u2014 DMHS Newsletter Crossword') : document.title;
    els.byline.textContent = (puzzle.title || 'This week\u2019s puzzle') + (puzzle.author ? ' \u00b7 by ' + puzzle.author : '');
    if (puzzle.notes) {
      els.notes.hidden = false;
      els.notes.textContent = puzzle.notes;
    }

    buildGridDom();
    buildClueLists();
    positionInput();
    updateSelectionUI();
    wireGameControls();
    startTimer();

    els.appRoot.hidden = false;
  }

  // -----------------------------------------------------------------------
  // Grid + clue list rendering
  // -----------------------------------------------------------------------
  function buildGridDom() {
    els.grid.style.setProperty('--cols', puzzle.width);
    els.grid.style.setProperty('--rows', puzzle.height);
    var frag = document.createDocumentFragment();

    for (var i = 0; i < state.cells.length; i++) {
      var cell = state.cells[i];
      var div = document.createElement('div');
      div.className = 'cell' + (cell.black ? ' black' : '');
      div.dataset.index = i;

      if (!cell.black) {
        var num = puzzle.cellNumber[i];
        if (num) {
          var numEl = document.createElement('span');
          numEl.className = 'num';
          numEl.textContent = num;
          div.appendChild(numEl);
        }
        var letterEl = document.createElement('span');
        letterEl.className = 'letter';
        div.appendChild(letterEl);
      }
      frag.appendChild(div);
    }
    els.grid.innerHTML = '';
    els.grid.appendChild(frag);

    els.grid.addEventListener('click', function (e) {
      var cellEl = e.target.closest('.cell');
      if (!cellEl || cellEl.classList.contains('black')) return;
      selectCell(parseInt(cellEl.dataset.index, 10));
      focusInput();
    });
  }

  function renderCell(idx) {
    var cell = state.cells[idx];
    if (cell.black) return;
    var el = els.grid.children[idx];
    var letterEl = el.querySelector('.letter');
    letterEl.textContent = cell.letter;
    el.classList.toggle('pencil', cell.pencil && !!cell.letter);
    el.classList.toggle('wrong', cell.isWrong);
    el.classList.toggle('was-wrong', cell.wasWrong);
    el.classList.toggle('revealed', cell.revealed);
  }

  function renderAllCells() {
    for (var i = 0; i < state.cells.length; i++) renderCell(i);
  }

  function buildClueLists() {
    els.acrossList.innerHTML = '';
    els.downList.innerHTML = '';
    puzzle.across.forEach(function (entry) { els.acrossList.appendChild(clueListItem(entry)); });
    puzzle.down.forEach(function (entry) { els.downList.appendChild(clueListItem(entry)); });
  }

  function clueListItem(entry) {
    var li = document.createElement('li');
    li.dataset.num = entry.num;
    li.dataset.dir = entry.dir;
    var numSpan = document.createElement('span');
    numSpan.className = 'clue-num';
    numSpan.textContent = entry.num + '.';
    var textSpan = document.createElement('span');
    textSpan.className = 'clue-text';
    textSpan.textContent = entry.clue;
    li.appendChild(numSpan);
    li.appendChild(textSpan);
    li.addEventListener('click', function () {
      state.direction = entry.dir;
      selectCell(firstEmptyCellIn(entry), true);
      focusInput();
    });
    return li;
  }

  // -----------------------------------------------------------------------
  // Selection + navigation
  // -----------------------------------------------------------------------
  function getEntry(idx, dir) {
    return dir === 'across' ? puzzle.acrossAt[idx] : puzzle.downAt[idx];
  }

  function firstEmptyCellIn(entry) {
    for (var i = 0; i < entry.cells.length; i++) {
      if (!state.cells[entry.cells[i]].letter) return entry.cells[i];
    }
    return entry.cell;
  }

  function selectCell(idx, keepDirection) {
    if (state.cells[idx].black) return;

    if (idx === state.currentIndex && !keepDirection) {
      var other = state.direction === 'across' ? 'down' : 'across';
      if (getEntry(idx, other)) state.direction = other;
    } else if (!getEntry(idx, state.direction)) {
      state.direction = state.direction === 'across' ? 'down' : 'across';
    }

    state.currentIndex = idx;
    updateSelectionUI();
  }

  function updateSelectionUI() {
    var prevSelected = els.grid.querySelector('.cell.selected');
    if (prevSelected) prevSelected.classList.remove('selected');
    var prevWord = els.grid.querySelectorAll('.cell.active-word');
    prevWord.forEach(function (el) { el.classList.remove('active-word'); });

    var entry = getEntry(state.currentIndex, state.direction);
    if (entry) {
      entry.cells.forEach(function (ci) { els.grid.children[ci].classList.add('active-word'); });
    }
    els.grid.children[state.currentIndex].classList.add('selected');

    var prevClue = document.querySelector('.clue-panel li.active-clue');
    if (prevClue) prevClue.classList.remove('active-clue');
    if (entry) {
      var li = document.querySelector('.clue-panel li[data-num="' + entry.num + '"][data-dir="' + entry.dir + '"]');
      if (li) {
        li.classList.add('active-clue');
        li.scrollIntoView({ block: 'nearest' });
      }
      els.currentClueText.textContent = entry.num + (entry.dir === 'across' ? ' Across' : ' Down') + '. ' + entry.clue;
    }

    positionInput();
  }

  function positionInput() {
    var cellEl = els.grid.children[state.currentIndex];
    if (!cellEl) return;
    preserveScroll(function () {
      var gridRect = els.grid.getBoundingClientRect();
      var cellRect = cellEl.getBoundingClientRect();
      els.letterInput.style.left = (cellRect.left - gridRect.left) + 'px';
      els.letterInput.style.top = (cellRect.top - gridRect.top) + 'px';
      els.letterInput.style.width = cellRect.width + 'px';
      els.letterInput.style.height = cellRect.height + 'px';
    });
  }

  function focusInput() {
    els.letterInput.value = '';
    preserveScroll(function () {
      els.letterInput.focus({ preventScroll: true });
    });
  }

  function moveArrow(key) {
    var axis = (key === 'ArrowLeft' || key === 'ArrowRight') ? 'across' : 'down';
    var dr = key === 'ArrowDown' ? 1 : key === 'ArrowUp' ? -1 : 0;
    var dc = key === 'ArrowRight' ? 1 : key === 'ArrowLeft' ? -1 : 0;

    state.direction = axis;
    var r = Math.floor(state.currentIndex / puzzle.width) + dr;
    var c = (state.currentIndex % puzzle.width) + dc;
    if (r < 0 || r >= puzzle.height || c < 0 || c >= puzzle.width) { updateSelectionUI(); return; }
    var idx = r * puzzle.width + c;
    if (state.cells[idx].black) { updateSelectionUI(); return; }
    state.currentIndex = idx;
    updateSelectionUI();
  }

  function moveHomeEnd(toEnd) {
    var entry = getEntry(state.currentIndex, state.direction);
    if (!entry) return;
    state.currentIndex = toEnd ? entry.cells[entry.cells.length - 1] : entry.cells[0];
    updateSelectionUI();
  }

  // Advances to the next (or previous) clue *in the current direction only*.
  // Finishing an across entry moves to the next across entry, never a down
  // one, and vice versa; the list wraps around at the end.
  function jumpClue(delta) {
    var entry = getEntry(state.currentIndex, state.direction);
    var list = state.direction === 'across' ? puzzle.across : puzzle.down;
    var pos = list.indexOf(entry);
    if (pos === -1) pos = 0;
    var next = list[(pos + delta + list.length) % list.length];
    state.direction = next.dir;
    state.currentIndex = firstEmptyCellIn(next);
    updateSelectionUI();
  }

  function toggleDirectionAtCurrent() {
    var other = state.direction === 'across' ? 'down' : 'across';
    if (getEntry(state.currentIndex, other)) state.direction = other;
    updateSelectionUI();
  }

  // -----------------------------------------------------------------------
  // Typing
  // -----------------------------------------------------------------------
  function typeLetter(ch) {
    var cell = state.cells[state.currentIndex];
    if (cell.black) return;

    cell.letter = ch.toUpperCase();
    cell.pencil = state.pencilMode;
    cell.revealed = false;
    if (state.autoCheck) {
      cell.isWrong = cell.letter !== puzzle.solution[state.currentIndex];
      if (cell.isWrong) cell.wasWrong = true;
    } else {
      cell.isWrong = false;
    }
    renderCell(state.currentIndex);

    var entry = getEntry(state.currentIndex, state.direction);
    var posInWord = entry.cells.indexOf(state.currentIndex);
    if (posInWord < entry.cells.length - 1) {
      state.currentIndex = entry.cells[posInWord + 1];
      updateSelectionUI();
    } else {
      jumpClue(1);
    }
    checkCompletion();
  }

  function backspace() {
    var cell = state.cells[state.currentIndex];
    if (cell.letter) {
      cell.letter = '';
      cell.isWrong = false;
      cell.revealed = false;
      renderCell(state.currentIndex);
      return;
    }
    var entry = getEntry(state.currentIndex, state.direction);
    var posInWord = entry.cells.indexOf(state.currentIndex);
    if (posInWord > 0) {
      state.currentIndex = entry.cells[posInWord - 1];
      var prevCell = state.cells[state.currentIndex];
      prevCell.letter = '';
      prevCell.isWrong = false;
      prevCell.revealed = false;
      renderCell(state.currentIndex);
      updateSelectionUI();
    }
  }

  // -----------------------------------------------------------------------
  // Check / reveal
  // -----------------------------------------------------------------------
  function checkCells(indices) {
    indices.forEach(function (idx) {
      var cell = state.cells[idx];
      if (cell.black || !cell.letter) return;
      var wrong = cell.letter !== puzzle.solution[idx];
      cell.isWrong = wrong;
      if (wrong) cell.wasWrong = true;
      renderCell(idx);
    });
  }

  function revealCells(indices) {
    indices.forEach(function (idx) {
      var cell = state.cells[idx];
      if (cell.black) return;
      cell.letter = puzzle.solution[idx];
      cell.revealed = true;
      cell.isWrong = false;
      cell.pencil = false;
      renderCell(idx);
    });
    checkCompletion();
  }

  function allIndices() {
    return state.cells.filter(function (c) { return !c.black; }).map(function (c) { return c.index; });
  }
  function wordIndices() {
    var entry = getEntry(state.currentIndex, state.direction);
    return entry ? entry.cells.slice() : [];
  }

  // -----------------------------------------------------------------------
  // Completion + timer
  // -----------------------------------------------------------------------
  function checkCompletion() {
    if (state.solved) return;
    var done = state.cells.every(function (c) { return c.black || c.letter === puzzle.solution[c.index]; });
    if (!done) return;
    state.solved = true;
    pauseTimer(false);
    var usedHelp = state.cells.some(function (c) { return c.revealed; });
    els.solvedBanner.hidden = false;
    els.solvedBanner.textContent = (usedHelp ? 'Completed with help \u2014 ' : '\ud83c\udf89 Solved! \u2014 ') + formatTime(state.timer.elapsed);
  }

  function formatTime(sec) {
    var m = Math.floor(sec / 60), s = sec % 60;
    var h = Math.floor(m / 60);
    m = m % 60;
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    return h > 0 ? (h + ':' + pad(m) + ':' + pad(s)) : (pad(m) + ':' + pad(s));
  }

  function renderTimer() {
    els.timerDisplay.textContent = formatTime(state.timer.elapsed);
  }

  function startTimer() {
    if (state.timer.running) return;
    state.timer.running = true;
    els.pauseOverlay.hidden = true;
    els.pauseBtn.textContent = '\u23f8';
    els.pauseBtn.setAttribute('aria-label', 'Pause timer');
    state.timer.intervalId = setInterval(function () {
      state.timer.elapsed++;
      renderTimer();
    }, 1000);
  }

  function pauseTimer(showOverlay) {
    if (!state.timer.running) return;
    state.timer.running = false;
    clearInterval(state.timer.intervalId);
    els.pauseBtn.textContent = '\u25b6';
    els.pauseBtn.setAttribute('aria-label', 'Resume timer');
    if (showOverlay !== false) els.pauseOverlay.hidden = false;
  }

  // -----------------------------------------------------------------------
  // Reset
  // -----------------------------------------------------------------------
  function resetPuzzle() {
    if (!window.confirm('Clear all your answers and start this puzzle over?')) return;
    state.cells.forEach(function (c) {
      c.letter = ''; c.pencil = false; c.revealed = false; c.wasWrong = false; c.isWrong = false;
    });
    state.solved = false;
    state.timer.elapsed = 0;
    els.solvedBanner.hidden = true;
    renderAllCells();
    renderTimer();
    state.currentIndex = puzzle.sequence[0].cell;
    state.direction = puzzle.sequence[0].dir;
    updateSelectionUI();
    startTimer();
  }

  // -----------------------------------------------------------------------
  // Controls that exist before the puzzle has loaded
  // -----------------------------------------------------------------------
  function wireStaticControls() {
    els.helpBtn.addEventListener('click', function () { els.helpModal.hidden = false; });
    els.closeHelp.addEventListener('click', function () { els.helpModal.hidden = true; });
    els.helpModal.addEventListener('click', function (e) { if (e.target === els.helpModal) els.helpModal.hidden = true; });

    els.dropdowns.forEach(function (dd) {
      var btn = dd.querySelector('.dropdown-trigger');
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var wasOpen = dd.classList.contains('open');
        els.dropdowns.forEach(function (d) { d.classList.remove('open'); });
        if (!wasOpen) dd.classList.add('open');
      });
    });
    document.addEventListener('click', function () {
      els.dropdowns.forEach(function (d) { d.classList.remove('open'); });
    });
  }

  // -----------------------------------------------------------------------
  // Controls that need the puzzle to exist
  // -----------------------------------------------------------------------
  function wireGameControls() {
    els.prevClueBtn.addEventListener('click', function () { jumpClue(-1); focusInput(); });
    els.nextClueBtn.addEventListener('click', function () { jumpClue(1); focusInput(); });

    els.pauseBtn.addEventListener('click', function () {
      if (state.timer.running) pauseTimer(true); else startTimer();
    });
    els.resumeBtn.addEventListener('click', startTimer);

    els.pencilBtn.addEventListener('click', function () {
      state.pencilMode = !state.pencilMode;
      els.pencilBtn.classList.toggle('active', state.pencilMode);
      focusInput();
    });

    els.autocheckBtn.addEventListener('click', function () {
      state.autoCheck = !state.autoCheck;
      els.autocheckBtn.classList.toggle('active', state.autoCheck);
      if (state.autoCheck) checkCells(allIndices().filter(function (i) { return state.cells[i].letter; }));
      focusInput();
    });

    els.resetBtn.addEventListener('click', resetPuzzle);

    document.querySelectorAll('[data-action]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var action = btn.dataset.action;
        if (action === 'check-square') checkCells([state.currentIndex]);
        if (action === 'check-word') checkCells(wordIndices());
        if (action === 'check-puzzle') checkCells(allIndices());
        if (action === 'reveal-square') revealCells([state.currentIndex]);
        if (action === 'reveal-word') revealCells(wordIndices());
        if (action === 'reveal-puzzle') {
          if (window.confirm('Reveal the entire solution? This ends your attempt at solving it yourself.')) revealCells(allIndices());
        }
        focusInput();
      });
    });

    els.letterInput.addEventListener('keydown', handleKeydown);
    els.letterInput.addEventListener('input', handleInputFallback);

    window.addEventListener('resize', positionInput);
    focusInput();
  }

  function handleKeydown(e) {
    var key = e.key;
    if (key === 'Backspace') { e.preventDefault(); backspace(); els.letterInput.value = ''; return; }
    if (key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown') {
      e.preventDefault(); moveArrow(key); return;
    }
    if (key === 'Tab') { e.preventDefault(); jumpClue(e.shiftKey ? -1 : 1); return; }
    if (key === 'Enter') { e.preventDefault(); jumpClue(1); return; }
    if (key === ' ') { e.preventDefault(); toggleDirectionAtCurrent(); return; }
    if (key === 'Home') { e.preventDefault(); moveHomeEnd(false); return; }
    if (key === 'End') { e.preventDefault(); moveHomeEnd(true); return; }
    if (/^[a-zA-Z]$/.test(key)) { e.preventDefault(); typeLetter(key); els.letterInput.value = ''; return; }
  }

  // Fallback for on-screen/mobile keyboards that don't report a normal
  // keydown "key" value — reads whatever character landed in the hidden
  // input instead.
  function handleInputFallback(e) {
    var val = els.letterInput.value;
    els.letterInput.value = '';
    if (!val) return;
    var ch = val.charAt(val.length - 1);
    if (/^[a-zA-Z]$/.test(ch)) typeLetter(ch);
  }
})();
