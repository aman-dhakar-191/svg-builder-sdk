; Custom pages for the Windows installer (electron-builder NSIS "include" hooks).
;
; Wizard: Welcome -> Location (built in) -> Additional options -> Ready to install
;         -> Installing (built in) -> Finished (built in, with "Launch Curvant").
;
; Always installs for the current user (%LOCALAPPDATA%\Programs\Curvant), so it
; never needs admin rights; electron-builder's "for me / for all users" page is skipped.
;
; Shortcuts are created by electron-builder before customInstall runs; the
; options page only removes the ones the user unticked. Silent installs (/S)
; skip every page and keep both shortcuts.

!include nsDialogs.nsh
!include LogicLib.nsh

; The uninstaller is compiled from the same script; it has none of these pages,
; and an unused variable is a warning (electron-builder treats warnings as errors).
!ifndef BUILD_UNINSTALLER
Var optDesktop
Var optStartMenu
Var chkDesktop
Var chkStartMenu
!endif

!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

!macro customInit
  StrCpy $optDesktop ${BST_CHECKED}
  StrCpy $optStartMenu ${BST_CHECKED}
!macroend

!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Welcome to ${PRODUCT_NAME}"
  !define MUI_WELCOMEPAGE_TEXT "This wizard will guide you through the installation of ${PRODUCT_NAME} ${VERSION}.$\r$\n$\r$\nClick Next to continue."
  !insertmacro MUI_PAGE_WELCOME
!macroend

!macro customPageAfterChangeDir
  Page custom OptionsPageCreate OptionsPageLeave
  Page custom ReadyPageCreate

  ; Texts for the built-in finish page, which electron-builder adds after the install page.
  !define MUI_FINISHPAGE_TITLE "Installation Complete"
  !define MUI_FINISHPAGE_TEXT "${PRODUCT_NAME} has been installed on your computer.$\r$\n$\r$\nClick Finish to close this wizard."
  !define MUI_FINISHPAGE_RUN_TEXT "Launch ${PRODUCT_NAME}"

  Function OptionsPageCreate
    !insertmacro MUI_HEADER_TEXT "Additional Options" "Choose the shortcuts to create."
    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}
    ${NSD_CreateCheckbox} 0 0 100% 12u "Create a &desktop shortcut"
    Pop $chkDesktop
    ${NSD_SetState} $chkDesktop $optDesktop
    ${NSD_CreateCheckbox} 0 18u 100% 12u "Create a &Start Menu shortcut"
    Pop $chkStartMenu
    ${NSD_SetState} $chkStartMenu $optStartMenu
    nsDialogs::Show
  FunctionEnd

  Function OptionsPageLeave
    ${NSD_GetState} $chkDesktop $optDesktop
    ${NSD_GetState} $chkStartMenu $optStartMenu
  FunctionEnd

  Function ReadyPageCreate
    !insertmacro MUI_HEADER_TEXT "Ready to Install" "Setup is ready to install ${PRODUCT_NAME}."
    ; Same folder rule as electron-builder's install page: the app gets its own sub-folder.
    ${StrContains} $0 "${APP_FILENAME}" $INSTDIR
    ${If} $0 == ""
      StrCpy $INSTDIR "$INSTDIR\${APP_FILENAME}"
    ${EndIf}
    StrCpy $1 ""
    ${If} $optDesktop == ${BST_CHECKED}
      StrCpy $1 "desktop"
    ${EndIf}
    ${If} $optStartMenu == ${BST_CHECKED}
      ${If} $1 == ""
        StrCpy $1 "Start Menu"
      ${Else}
        StrCpy $1 "$1, Start Menu"
      ${EndIf}
    ${EndIf}
    ${If} $1 == ""
      StrCpy $1 "none"
    ${EndIf}
    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}
    ${NSD_CreateLabel} 0 0 100% 12u "Application: ${PRODUCT_NAME} ${VERSION}"
    Pop $0
    ${NSD_CreateLabel} 0 18u 100% 24u "Location: $INSTDIR"
    Pop $0
    ${NSD_CreateLabel} 0 46u 100% 12u "Shortcuts: $1"
    Pop $0
    ${NSD_CreateLabel} 0 70u 100% 12u "Click Install to continue, or Back to change these settings."
    Pop $0
    GetDlgItem $0 $HWNDPARENT 1
    SendMessage $0 ${WM_SETTEXT} 0 "STR:$(^InstallBtn)"
    nsDialogs::Show
  FunctionEnd
!macroend

!macro customInstall
  ${If} $optDesktop != ${BST_CHECKED}
    WinShell::UninstShortcut "$newDesktopLink"
    Delete "$newDesktopLink"
  ${EndIf}
  ${If} $optStartMenu != ${BST_CHECKED}
    WinShell::UninstShortcut "$newStartMenuLink"
    Delete "$newStartMenuLink"
    StrCpy $launchLink "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  ${EndIf}
!macroend
