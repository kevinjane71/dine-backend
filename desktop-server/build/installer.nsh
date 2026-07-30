; Custom NSIS install steps for DineOpen Server.
; The installer runs elevated (perMachine), so this is the reliable place to open
; the Windows Firewall for port 3003 — terminals can't reach the server otherwise.

!macro customInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="DineOpen Server"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="DineOpen Server" dir=in action=allow protocol=TCP localport=3003'
!macroend

!macro customUnInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="DineOpen Server"'
  ; NOTE: we intentionally do NOT delete the restaurant's data (~/DineOpenServer).
!macroend
