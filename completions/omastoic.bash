# bash completion for omastoic
# Installed to ~/.local/share/bash-completion/completions/omastoic by `omastoic setup`.

_omastoic() {
  local cur prev cmd
  COMPREPLY=()
  cur="${COMP_WORDS[COMP_CWORD]}"
  prev="${COMP_WORDS[COMP_CWORD - 1]}"
  cmd="${COMP_WORDS[1]}"

  local commands="toggle next preview show config ui portrait author status uninstall help"
  local authors="@AUTHORS@"

  if ((COMP_CWORD == 1)); then
    mapfile -t COMPREPLY < <(compgen -W "$commands" -- "$cur")
    return 0
  fi

  case "$cmd" in
  config | configure)
    if [[ $prev == --authors || $cur == *,* ]]; then
      local prefix="" last="$cur"
      if [[ $cur == *,* ]]; then
        prefix="${cur%,*},"
        last="${cur##*,}"
      fi
      local -a hits=()
      mapfile -t hits < <(compgen -W "$authors" -- "$last")
      COMPREPLY=("${hits[@]/#/${prefix}}")
      return 0
    fi
    if [[ $prev == --interval || $prev == --quotes || $prev == --add ]]; then
      return 0
    fi
    mapfile -t COMPREPLY < <(compgen -W "--authors --interval --quotes --add --list --plain" -- "$cur")
    ;;
  author)
    if ((COMP_CWORD == 2)); then
      mapfile -t COMPREPLY < <(compgen -W "add list remove" -- "$cur")
    else
      mapfile -t COMPREPLY < <(compgen -W "--dates --image --drawing" -- "$cur")
    fi
    ;;
  uninstall)
    mapfile -t COMPREPLY < <(compgen -W "--purge" -- "$cur")
    ;;
  show)
    mapfile -t COMPREPLY < <(compgen -W "--cols --rows" -- "$cur")
    ;;
  esac
}

complete -F _omastoic omastoic
