; Custom NSIS wizard pages for Materia Browser (auto-included by electron-builder).
; electron-builder only renders a welcome page if customWelcomePage is defined, and
; only honors finish-page text if customFinishPage is defined.

!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Welcome to Materia Browser"
  !define MUI_WELCOMEPAGE_TEXT "A private, fast browser by MarrowMyth, powered by Materia. What's inside:$\r$\n$\r$\n- Ad, tracker and pop-up blocking + encrypted DNS$\r$\n- Safe Browsing, leak protection, zero telemetry$\r$\n- Workspaces, each with its own color theme$\r$\n- Pin, mute, reorder, reopen and split tabs$\r$\n- Bookmarks with folders + your social icons$\r$\n- Smart address bar: suggestions, bangs, AI$\r$\n- Video downloader, find-in-page, zoom and themes$\r$\n$\r$\nClick Next to get started."
  !insertmacro MUI_PAGE_WELCOME
!macroend

!macro customFinishPage
  !ifndef HIDE_RUN_AFTER_FINISH
    Function StartApp
      ${if} ${isUpdated}
        StrCpy $1 "--updated"
      ${else}
        StrCpy $1 ""
      ${endif}
      ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
    FunctionEnd
    !define MUI_FINISHPAGE_RUN
    !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
    !define MUI_FINISHPAGE_RUN_TEXT "Open Materia Browser"
  !endif
  !define MUI_FINISHPAGE_TITLE "Materia Browser is installed"
  !define MUI_FINISHPAGE_TEXT "Built for me, by me, to help cut through my tab and social-media noise. Thank you for downloading Materia - I hope it helps with yours too."
  !define MUI_FINISHPAGE_LINK "Enjoying Materia? Support development on Ko-fi"
  !define MUI_FINISHPAGE_LINK_LOCATION "https://ko-fi.com/marrowmyth"
  !insertmacro MUI_PAGE_FINISH
!macroend
