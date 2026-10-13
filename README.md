# Istinto Puro

Scegli due o più squadre di calcio (club o nazionali) e scopri quali calciatori hanno giocato in tutte, con gli anni passati in ciascuna.

## Come funziona

- **Squadre**: `public/teams.json` contiene circa 12.800 club e nazionali presi da Wikidata, con nomi italiani, alias e stemmi. I suggerimenti si cercano direttamente nel browser: sono istantanei e non fanno richieste in rete.
- **Giocatori**: una sola query SPARQL a [Wikidata](https://query.wikidata.org) per ogni ricerca (proprietà P54 "squadra di appartenenza", con gli anni dai qualificatori P580/P582). I risultati restano in cache nel browser per 3 giorni.
- **Modalità gioco**: "Nascondi nomi" copre i giocatori. Scrivendo un nome in "Controlla un nome" vedi se la risposta è valida senza scoprire gli altri.
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

- I dati dipendono da Wikidata: giocatori di serie minori o con carriere poco documentate possono mancare, e a volte mancano gli anni.
- Prima squadra, giovanili, squadra B e femminile sono voci separate.
