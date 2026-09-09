import json
def main():
    with open('dataset/captcha_labels.json', 'r') as f:
        captcha_labels = json.load(f)
    print(len(captcha_labels))


if __name__ == "__main__":
    main()
