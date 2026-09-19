#!/usr/bin/env python3
"""Kör ett kommando med en riktig styrterminal (pty) och agera när viss text dyker upp.

Varför: provision.sh ställer sina JA-frågor mot /dev/tty. Utan terminal misslyckas läsningen
direkt, och då går det bara att pröva EN väg genom koden (ingen terminal => ångra). Avbrott
VID frågan — Ctrl-C, SIGTERM, kill -9 — och ett riktigt JA kräver en terminal.

  pty-kor.py [--tidsgrans SEK] [--handling 'MÖNSTER=>ÅTGÄRD']… -- kommando [argument…]

Åtgärderna utförs i tur och ordning; var och en väntar på att MÖNSTER (ren text) dyker upp i
utdata EFTER den plats där föregående åtgärd utlöstes.

  skicka:TEXT   skriv TEXT + radbrytning till terminalen
  ctrlc         skriv ^C till terminalen (SIGINT till hela förgrundsgruppen, som på riktigt)
  signal:NAMN   skicka SIGNAMN (INT, TERM, KILL, HUP …) till kommandots process
  kor:KOMMANDO  kör KOMMANDO i ett skal medan frågan står obesvarad; utdata läggs i fångsten
                inramad av '[[kor: …]]' så att testet kan läsa av läget MITT I fönstret

Fångad utdata skrivs på stdout. Slutkod: kommandots (128 + signalnummer om det dödades),
124 om tidsgränsen löpte ut, 125 om ett mönster aldrig dök upp innan kommandot avslutades.
"""

import os
import pty
import select
import signal
import subprocess
import sys
import time


def tolka_argument(argv):
    tidsgrans = 60.0
    handlingar = []
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--":
            return tidsgrans, handlingar, argv[i + 1:]
        if a == "--tidsgrans":
            tidsgrans = float(argv[i + 1])
            i += 2
            continue
        if a == "--handling":
            monster, skilje, atgard = argv[i + 1].partition("=>")
            if not skilje:
                sys.exit("pty-kor: --handling kräver formen 'MÖNSTER=>ÅTGÄRD'")
            handlingar.append((monster.encode(), atgard))
            i += 2
            continue
        sys.exit(f"pty-kor: okänt argument {a!r}")
    sys.exit("pty-kor: '--' följt av ett kommando saknas")


def main():
    tidsgrans, handlingar, kommando = tolka_argument(sys.argv[1:])
    if not kommando:
        sys.exit("pty-kor: inget kommando")

    pid, fd = pty.fork()
    if pid == 0:
        try:
            os.execvp(kommando[0], kommando)
        except OSError as fel:
            os.write(2, f"pty-kor: kan inte köra {kommando[0]}: {fel}\n".encode())
            os._exit(127)

    fangst = bytearray()
    sokt_fran = 0
    slut = time.monotonic() + tidsgrans
    tidsgrans_lopte_ut = False

    def utfor(atgard):
        nonlocal fangst
        slag, _, varde = atgard.partition(":")
        if slag == "skicka":
            os.write(fd, varde.encode() + b"\n")
        elif slag == "ctrlc":
            os.write(fd, b"\x03")
        elif slag == "signal":
            os.kill(pid, getattr(signal, "SIG" + varde))
        elif slag == "kor":
            # Avsiktligt ett skal: KOMMANDO är testets EGEN text (skriven i testfilen), aldrig
            # indata utifrån. Hjälpmedlet körs bara i en engångscontainer.
            ut = subprocess.run(["bash", "-c", varde], capture_output=True, text=True, check=False)
            fangst += f"\n[[kor: {varde}]]\n{ut.stdout}{ut.stderr}[[/kor kod={ut.returncode}]]\n".encode()
        else:
            sys.exit(f"pty-kor: okänd åtgärd {atgard!r}")

    while True:
        # Utför alla åtgärder vars mönster redan finns i fångsten.
        while handlingar:
            monster, atgard = handlingar[0]
            plats = fangst.find(monster, sokt_fran)
            if plats < 0:
                break
            sokt_fran = plats + len(monster)
            handlingar.pop(0)
            utfor(atgard)
            if atgard.startswith("kor:"):
                sokt_fran = len(fangst)

        kvar = slut - time.monotonic()
        if kvar <= 0:
            tidsgrans_lopte_ut = True
            os.kill(pid, signal.SIGKILL)
            break
        klara, _, _ = select.select([fd], [], [], min(kvar, 0.5))
        if not klara:
            continue
        try:
            bit = os.read(fd, 65536)
        except OSError:
            break  # EIO: alla ändar av terminalen är stängda
        if not bit:
            break
        fangst += bit

    _, status = os.waitpid(pid, 0)
    sys.stdout.write(fangst.decode("utf-8", "replace"))
    sys.stdout.flush()
    if tidsgrans_lopte_ut:
        sys.stdout.write("\n[[pty-kor: TIDSGRÄNSEN löpte ut]]\n")
        sys.exit(124)
    if handlingar:
        sys.stdout.write(f"\n[[pty-kor: mönstret {handlingar[0][0].decode()!r} dök aldrig upp]]\n")
        sys.exit(125)
    if os.WIFSIGNALED(status):
        sys.exit(128 + os.WTERMSIG(status))
    sys.exit(os.WEXITSTATUS(status))


if __name__ == "__main__":
    main()
