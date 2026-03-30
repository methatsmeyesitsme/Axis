import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";

const LANGUAGES = [
  "JavaScript", "TypeScript", "Python", "Java", "C++", "C#", "Go", "Rust",
  "PHP", "Ruby", "Swift", "Kotlin", "Dart", "Lua", "Luau", "SQL", "HTML/CSS", "Shell/Bash", "R", "MATLAB"
];

interface LanguageSelectorProps {
  value: string;
  onChange: (value: string) => void;
}

export default function LanguageSelector({ value, onChange }: LanguageSelectorProps) {
  return (
    <div className="flex flex-col gap-2 w-full text-left">
      <Label htmlFor="language-select" className="text-sm font-medium text-muted-foreground">
        Programming Language
      </Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id="language-select" className="w-full h-12 bg-white border-input shadow-sm rounded-xl">
          <SelectValue placeholder="Select a language" />
        </SelectTrigger>
        <SelectContent className="max-h-[300px]">
          {LANGUAGES.map(lang => (
            <SelectItem key={lang} value={lang}>
              {lang}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
