# Istinto Puro

Scegli due o più squadre di calcio (club o nazionali) e scopri quali calciatori hanno giocato in tutte, con gli anni passati in ciascuna.

## Come funziona

- **Squadre**: `public/teams.json` contiene circa 12.800 club e nazionali presi da Wikidata, con nomi italiani, alias e stemmi. I suggerimenti si cercano direttamente nel browser: sono istantanei e non fanno richieste in rete.
- **Giocatori**: archivio precalcolato in `public/rosters/` (un file per squadra), generato da `npm run teams`, `npm run careers` e `npm run rosters`: carriere da [Wikidata](https://www.wikidata.org) più i periodi che mancano presi da Wikipedia in italiano. L'app incrocia le squadre sul dispositivo, senza query a ogni ricerca. Le squadre rifondate (es. Vicenza Calcio e L.R. Vicenza) contano come una sola. Senza archivio l'app interroga Wikidata e Wikipedia dal vivo.
- **Modalità**: "Elenco" mostra tutti i giocatori; "Gioca" li copre e si scoprono indovinandoli.
- Il link contiene le squadre scelte (`?squadre=Q1422,Q2641`), quindi si può condividere.

Non servono server o chiavi API: è un sito statico.

## Sviluppo

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # test su ricerca squadre e lettura dei dati
npm run build    # sito statico in dist/
```

Per aggiornare l'elenco delle squadre (ogni qualche mese basta):

```bash
npm run teams
```

## Limiti noti

- I dati dipendono da Wikidata e Wikipedia italiana: giocatori di serie minori o senza voce su Wikipedia possono mancare, e a volte mancano gli anni.
- Prima squadra, giovanili, squadra B e femminile sono voci separate.

## Licenza

© 2026 Alessandro Gazzoni. Tutti i diritti riservati: vedi [LICENSE](LICENSE), che elenca anche le licenze dei materiali di terzi (dati, foto, stemmi, caratteri, icone). App non ufficiale, ispirata al format Istinto Puro di Cronache di Spogliatoio.
