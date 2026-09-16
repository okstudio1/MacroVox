; MacroVox NSIS installer hooks for Tauri 2.
;
; NSIS_HOOK_PREINSTALL  : runs before file copy. Kill running instance,
;                         detect and remove previous installs from other dirs.
; NSIS_HOOK_POSTINSTALL : runs after file copy. Force-create shortcuts.
; NSIS_HOOK_POSTUNINSTALL : runs after uninstall. Clean up shortcuts.

!macro NSIS_HOOK_PREINSTALL
  ; --- Kill running MacroVox process ---
  nsExec::ExecToStack 'cmd /c tasklist /FI "IMAGENAME eq MacroVox.exe" /NH 2>nul | findstr /I "MacroVox.exe"'
  Pop $0
  ${If} $0 == 0
    MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "MacroVox is currently running.$\r$\n$\r$\nClick OK to close it and continue installing, or Cancel to abort." IDOK killIt
    Abort
    killIt:
      nsExec::ExecToLog 'taskkill /F /IM "MacroVox.exe"'
      ; Poll until fully exited (up to 8s) so file handles are released.
      StrCpy $9 0
      pollExit:
        Sleep 1000
        IntOp $9 $9 + 1
        ${If} $9 >= 8
          Goto pollDone
        ${EndIf}
        nsExec::ExecToStack 'cmd /c tasklist /FI "IMAGENAME eq MacroVox.exe" /NH 2>nul | findstr /I "MacroVox.exe"'
        Pop $0
        ${If} $0 == 0
          Goto pollExit
        ${EndIf}
      pollDone:
  ${EndIf}

  ; HKCU is user-writable. Never execute its UninstallString in this
  ; elevated per-machine installer. In-place upgrades use Tauri's normal
  ; installer path. Older per-user installs can be removed in Windows Settings.
  ReadRegStr $2 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MacroVox" "InstallLocation"
  ${If} $2 != ""
  ${AndIf} $2 != "$INSTDIR"
  ${AndIf} $2 != "$INSTDIR\"
    IfSilent skipPerUserNotice
    MessageBox MB_OK|MB_ICONINFORMATION "An older per-user installation of MacroVox was found.$\r$\n$\r$\nYou can remove it separately in Windows Settings > Apps from that user account. This installer will leave it in place."
    skipPerUserNotice:
  ${EndIf}

  ; --- Remove previous per-machine install (HKLM) from a different directory ---
  ReadRegStr $0 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\MacroVox" "UninstallString"
  ReadRegStr $2 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\MacroVox" "InstallLocation"
  ${If} $0 != ""
  ${AndIf} $2 != ""
  ${AndIf} $2 != "$INSTDIR"
  ${AndIf} $2 != "$INSTDIR\"
    ReadRegStr $1 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\MacroVox" "DisplayVersion"
    MessageBox MB_YESNO|MB_ICONQUESTION "A previous system-wide installation of MacroVox (v$1) was found at:$\r$\n$2$\r$\n$\r$\nWould you like to remove it?$\r$\n(Recommended: Yes)" IDYES removePrevHKLM IDNO skipPrevHKLM
    removePrevHKLM:
      ExecWait '"$0" /S'
      Sleep 2000
    skipPrevHKLM:
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; --- Create shortcuts (perMachine: admin context, paths are system-wide) ---
  CreateDirectory "$SMPROGRAMS\MacroVox"
  CreateShortCut "$SMPROGRAMS\MacroVox\MacroVox.lnk" "$INSTDIR\MacroVox.exe" "" "$INSTDIR\MacroVox.exe" 0
  CreateShortCut "$DESKTOP\MacroVox.lnk" "$INSTDIR\MacroVox.exe" "" "$INSTDIR\MacroVox.exe" 0
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; --- Clean up shortcuts ---
  Delete "$DESKTOP\MacroVox.lnk"
  Delete "$SMPROGRAMS\MacroVox\MacroVox.lnk"
  RMDir "$SMPROGRAMS\MacroVox"

  ; --- Offer to remove user data (mirrors alpha-osk's installer.nsh) ---
  ; The app keeps everything under %LOCALAPPDATA%\com.okstudio.macrovox:
  ;   - voice-buffer\ : saved dictation recordings (OGG Opus)
  ;   - EBWebView\     : the WebView2 profile, which holds localStorage -- and
  ;                      localStorage is where bring-your-own Deepgram /
  ;                      Anthropic API keys live. Leaving it behind on uninstall
  ;                      means user secrets linger on disk.
  ; Silent uninstall (/S) is the auto-updater's upgrade path -- never wipe data
  ; there. Only prompt during an interactive uninstall.
  IfSilent keepUserData
  MessageBox MB_YESNO|MB_ICONQUESTION "Also remove MacroVox's saved data?$\r$\n$\r$\nThis deletes your dictation recordings and saved settings, including any API keys you entered.$\r$\n$\r$\n(Choose No to keep them for a future reinstall.)" IDYES removeUserData IDNO keepUserData
  removeUserData:
    RMDir /r "$LOCALAPPDATA\com.okstudio.macrovox"
  keepUserData:
!macroend
